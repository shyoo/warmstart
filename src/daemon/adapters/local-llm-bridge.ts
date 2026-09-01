/**
 * Bridge between Multi Agent Controller's stream transport and an OpenAI-compatible local LLM server.
 *
 * ⛔ This runs as a **child process**, not inside the daemon. It is spawned by `sessions.ts` the same
 * way any other adapter's CLI is spawned, and communicates through stdin/stdout with NDJSON records
 * that `decodeStream` in `local-llm.ts` understands.
 *
 * The bridge:
 *  1. Reads environment variables for endpoint, model, and context size
 *  2. Emits an `init` record immediately
 *  3. Reads prompts from stdin (NDJSON, one per line)
 *  4. Calls the local `/v1/chat/completions` endpoint with streaming
 *  5. Writes NDJSON records to stdout as the response arrives
 *  6. Handles tool calls by executing them inline and continuing the conversation
 *  7. Keeps stdin open for follow-up prompts (multi-turn)
 *
 * Wire format (stdout, one JSON object per line):
 *   { "type": "init", "model": "...", "session_id": null }
 *   { "type": "assistant_text", "text": "..." }
 *   { "type": "tool_call", "name": "...", "arguments": "..." }
 *   { "type": "usage", "usage": { "input_tokens": N, "output_tokens": N, ... } }
 *   { "type": "result", "text": "...", "status": "SUCCESS"|"ERROR" }
 */

import * as http from 'node:http'
import * as https from 'node:https'
import { createInterface } from 'node:readline'

// ---------------------------------------------------------------------------- configuration

const ENDPOINT = process.env.LOCAL_LLM_ENDPOINT ?? 'http://127.0.0.1:8080'
const MODEL = process.env.LOCAL_LLM_MODEL ?? ''
const CONTEXT_SIZE = Number.parseInt(process.env.LOCAL_LLM_CONTEXT_SIZE ?? '32768', 10)
const SESSION_ID = process.env.LOCAL_LLM_SESSION_ID ?? null

// ---------------------------------------------------------------------------- types

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

// ---------------------------------------------------------------------------- tool definitions
// ⛔ These are the MAC tools the local LLM can call. They are declared in the OpenAI function-calling
// format and translated to MAC stream events by this bridge. The daemon handles them from there.

const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'task_complete',
      description:
        'Signal that the current task is complete. Call this when you have finished all the work ' +
        'requested in the task description. Include a brief summary of what was accomplished.',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'A brief summary of what was accomplished.'
          }
        },
        required: ['summary']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_human',
      description:
        'Ask the human operator a question when you need clarification or a decision. ' +
        'The task will be paused until the human responds.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The question to ask the human.'
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of choices for the human to pick from.'
          }
        },
        required: ['question']
      }
    }
  }
]

// ---------------------------------------------------------------------------- helpers

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

function log(msg: string): void {
  process.stderr.write(`[local-llm-bridge] ${msg}\n`)
}

// ---------------------------------------------------------------------------- HTTP client

async function chatCompletion(
  messages: ChatMessage[],
  onDelta: (text: string) => void,
  onToolCall: (calls: ToolCall[]) => void,
  onUsage: (usage: { input_tokens: number; output_tokens: number }) => void
): Promise<{ text: string; toolCalls: ToolCall[]; finishReason: string }> {
  const url = new URL('/v1/chat/completions', ENDPOINT)
  const body = JSON.stringify({
    model: MODEL || undefined,
    messages,
    stream: true,
    tools: TOOLS.length > 0 ? TOOLS : undefined,
    max_tokens: Math.min(CONTEXT_SIZE, 16384),
    temperature: 0.7,
    top_p: 0.8
  })

  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const req = transport.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errBody = ''
          res.on('data', (d: Buffer) => { errBody += d.toString() })
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 500)}`)))
          return
        }

        let buffer = ''
        let fullText = ''
        const allToolCalls = new Map<number, ToolCall>()
        let finishReason = 'stop'

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data: ')) continue
            const data = trimmed.slice(6)
            if (data === '[DONE]') continue

            let parsed: Record<string, unknown>
            try {
              parsed = JSON.parse(data) as Record<string, unknown>
            } catch {
              continue
            }

            const choices = parsed.choices as Array<Record<string, unknown>> | undefined
            if (!choices?.[0]) continue
            const choice = choices[0]
            const delta = choice.delta as Record<string, unknown> | undefined

            if (choice.finish_reason && typeof choice.finish_reason === 'string') {
              finishReason = choice.finish_reason
            }

            if (delta?.content && typeof delta.content === 'string') {
              fullText += delta.content
              onDelta(delta.content)
            }

            // Tool calls come as deltas with indexed parts
            const toolCallDeltas = delta?.tool_calls as
              | Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
              | undefined
            if (toolCallDeltas) {
              for (const tc of toolCallDeltas) {
                let existing = allToolCalls.get(tc.index)
                if (!existing) {
                  existing = {
                    id: tc.id ?? `call_${tc.index}`,
                    type: 'function',
                    function: { name: '', arguments: '' }
                  }
                  allToolCalls.set(tc.index, existing)
                }
                if (tc.id) existing.id = tc.id
                if (tc.function?.name) existing.function.name += tc.function.name
                if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
              }
            }

            // Usage in the final chunk (llama.cpp reports it here)
            const usage = parsed.usage as
              | { prompt_tokens?: number; completion_tokens?: number }
              | undefined
            if (usage) {
              onUsage({
                input_tokens: usage.prompt_tokens ?? 0,
                output_tokens: usage.completion_tokens ?? 0
              })
            }
          }
        })

        res.on('end', () => {
          const calls = Array.from(allToolCalls.values())
          if (calls.length > 0) onToolCall(calls)
          resolve({ text: fullText, toolCalls: calls, finishReason })
        })

        res.on('error', reject)
      }
    )

    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ---------------------------------------------------------------------------- tool execution
// ⛔ Tool execution here is trivial: the bridge emits the tool call as a stream event and returns
// a confirmation. The daemon's stream handler picks it up and routes it through the MCP/task system.
// For now, tool results are synthetic — the bridge does not wait for MAC to execute and reply.

function executeToolCall(call: ToolCall): string {
  const name = call.function.name
  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.function.arguments) as Record<string, unknown>
  } catch {
    return JSON.stringify({ error: 'could not parse tool arguments' })
  }

  if (name === 'task_complete') {
    // Emit a special record the adapter's decodeStream recognises as task completion.
    emit({
      type: 'tool_result',
      tool: 'task_complete',
      summary: typeof args.summary === 'string' ? args.summary : ''
    })
    return JSON.stringify({ status: 'completed' })
  }

  if (name === 'ask_human') {
    emit({
      type: 'tool_result',
      tool: 'ask_human',
      question: typeof args.question === 'string' ? args.question : '',
      options: Array.isArray(args.options) ? args.options : []
    })
    return JSON.stringify({ status: 'question_asked', note: 'The human has been notified.' })
  }

  return JSON.stringify({ error: `unknown tool: ${name}` })
}

// ---------------------------------------------------------------------------- main loop

async function runConversation(prompt: string, messages: ChatMessage[]): Promise<void> {
  messages.push({ role: 'user', content: prompt })

  let continueLoop = true
  while (continueLoop) {
    continueLoop = false

    try {
      const result = await chatCompletion(
        messages,
        (text) => emit({ type: 'assistant_text', text }),
        (calls) => {
          for (const call of calls) {
            emit({ type: 'tool_call', name: call.function.name, arguments: call.function.arguments })
          }
        },
        (usage) => {
          emit({
            type: 'usage',
            usage: {
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cache_read_tokens: 0,
              cache_write_tokens: 0,
              thinking_tokens: 0
            },
            final: true
          })
        }
      )

      if (result.toolCalls.length > 0) {
        // Add the assistant message with tool calls
        messages.push({
          role: 'assistant',
          content: result.text || null,
          tool_calls: result.toolCalls
        })

        // Check if task_complete was called — if so, we are done
        const completed = result.toolCalls.some((c) => c.function.name === 'task_complete')

        // Execute each tool call and add results
        for (const call of result.toolCalls) {
          const toolResult = executeToolCall(call)
          messages.push({
            role: 'tool',
            content: toolResult,
            tool_call_id: call.id,
            name: call.function.name
          })
        }

        if (completed) {
          // Emit the terminal result
          emit({
            type: 'result',
            text: result.text,
            status: 'SUCCESS'
          })
        } else {
          // Continue the conversation for non-terminal tool calls
          continueLoop = true
        }
      } else {
        // No tool calls — the model finished with plain text
        messages.push({ role: 'assistant', content: result.text })
        emit({
          type: 'result',
          text: result.text,
          status: 'SUCCESS'
        })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`error: ${msg}`)
      emit({
        type: 'result',
        text: `Error communicating with local LLM: ${msg}`,
        status: 'ERROR'
      })
    }
  }
}

async function main(): Promise<void> {
  // Emit init record immediately so the session is identified
  emit({ type: 'init', model: MODEL || 'local', session_id: SESSION_ID })

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are a coding assistant working on a software project. ' +
        'When you have completed the task, call the task_complete tool with a summary. ' +
        'If you need clarification from the human, call the ask_human tool.'
    }
  ]

  // Read prompts from stdin, one NDJSON object per line
  const rl = createInterface({ input: process.stdin })

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let prompt: string
    try {
      // Try to parse as JSON (the daemon's stream-json format)
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      // Support the Antigravity-style envelope: { event: 'user', message: { role: 'user', content: [...] } }
      if (parsed.event === 'user' || parsed.type === 'user') {
        const message = parsed.message as Record<string, unknown> | undefined
        const content = message?.content
        if (typeof content === 'string') {
          prompt = content
        } else if (Array.isArray(content)) {
          prompt = content
            .filter(
              (b: unknown): b is { type: string; text: string } =>
                !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
            )
            .map((b) => b.text)
            .join('')
        } else {
          prompt = trimmed
        }
      } else {
        // Bare text JSON-encoded
        prompt = typeof parsed.prompt === 'string' ? parsed.prompt : trimmed
      }
    } catch {
      // Not JSON — treat the whole line as the prompt (like codex exec)
      prompt = trimmed
    }

    if (!prompt) continue
    await runConversation(prompt, messages)
  }

  // stdin closed — exit cleanly
  process.exit(0)
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
