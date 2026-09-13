import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adapter } from './index.js'

const REPO = resolve(__dirname, '../../..')

describe('local-llm adapter unit tests', () => {
  const ad = adapter('local-llm')

  it('declares expected capabilities and policy', () => {
    expect(ad.info.id).toBe('local-llm')
    expect(ad.info.label).toBe('Local LLM')
    expect(ad.info.capabilities).toEqual({
      transports: ['stream'],
      permissionModes: ['default', 'read-only'],
      readOnlyPermissionMode: 'read-only',
      classifierBackedAuto: false,
      approvalChannel: 'none',
      manualCompact: false,
      resumeSession: false,
      mcp: false,
      quotaProbe: 'none',
      // Nothing to bill: the model runs on the operator's own machine.
      spendProbe: 'none',
      streamPrompts: 'conversation',
      // The bridge flushes on a rung, not on a message: the peephole must reassemble it.
      outputFraming: 'delta',
      // ⚠️ Already as partial as it gets. `false` here means *nothing to turn on*, not less detail.
      streamsPartialOutput: false,
      metering: 'stream',
      maxAccounts: null,
      mintsSessionId: false,
      imageInput: 'none',
      nativeWorktree: false,
      forkSession: false,
      selectableEffort: false
    })
    expect(ad.info.policy.defaultPermissionMode).toBe('default')
    expect(ad.info.policy.costModelId).toBe('local.llm.2026-09')
    expect(ad.info.policy.wrapUpProtocol).toBe('handoff')
    expect(ad.info.policy.needsExplicitBudget).toBe(true)
  })

  it('plan configures process.execPath with ELECTRON_RUN_AS_NODE and environment', () => {
    const plan = ad.plan({
      sessionId: 'sess-abc-123',
      isolationRoot: 'http://127.0.0.1:8080',
      cwd: 'C:/some/repo',
      transport: 'stream',
      model: 'qwen3-coder-30b'
    })

    expect(plan.command).toBe(process.execPath)
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(plan.env.LOCAL_LLM_ENDPOINT).toBe('http://127.0.0.1:8080')
    expect(plan.env.LOCAL_LLM_MODEL).toBe('qwen3-coder-30b')
    expect(plan.env.LOCAL_LLM_PERMISSION_MODE).toBe('default')
    expect(plan.env.LOCAL_LLM_SESSION_ID).toBe('sess-abc-123')
    expect(plan.args.length).toBeGreaterThan(0)
  })

  it('plan honours explicit permissionMode', () => {
    const plan = ad.plan({
      sessionId: 'sess-abc-456',
      isolationRoot: 'http://127.0.0.1:8080',
      cwd: 'C:/some/repo',
      transport: 'stream',
      permissionMode: 'read-only'
    })

    expect(plan.env.LOCAL_LLM_PERMISSION_MODE).toBe('read-only')
  })

  it('plan supports custom argv', () => {
    const plan = ad.plan({
      sessionId: 'sess-custom',
      isolationRoot: 'http://127.0.0.1:8080',
      cwd: 'C:/some/repo',
      transport: 'stream',
      argv: ['--version']
    })

    expect(plan.command).toBe(process.execPath)
    expect(plan.args).toEqual(['--version'])
  })

  it('probeQuota returns empty windows and tests endpoint reachability', async () => {
    // When unreachable:
    const quotaUnreachable = await ad.probeQuota('http://127.0.0.1:1')
    expect(quotaUnreachable.windows).toEqual([])
    expect(quotaUnreachable.source).toBe('unknown')
    expect(quotaUnreachable.error).toMatch(/connect|ECONNREFUSED/i)

    // When isolationRoot not provided:
    const quotaNone = await ad.probeQuota('')
    expect(quotaNone.windows).toEqual([])
    expect(quotaNone.source).toBe('cli')
    expect(quotaNone.error).toBeUndefined()
  })

  it('encodeStreamPrompt serialises into Antigravity-compatible stream JSON', () => {
    const encoded = ad.encodeStreamPrompt!('test prompt')
    const parsed = JSON.parse(encoded) as { event: string; message: { role: string; content: Array<{ type: string; text: string }> } }
    expect(parsed.event).toBe('user')
    expect(parsed.message.role).toBe('user')
    expect(parsed.message.content[0]?.text).toBe('test prompt')
  })

  describe('decodeStream', () => {
    const decode = ad.decodeStream!

    it('decodes init record', () => {
      expect(decode({ type: 'init', model: 'qwen3-coder', session_id: 's-1' })).toEqual({
        kind: 'init',
        sessionId: 's-1',
        model: 'qwen3-coder',
        permissionMode: null
      })
    })

    it('decodes assistant_text record', () => {
      expect(decode({ type: 'assistant_text', text: 'hello world' })).toEqual({
        kind: 'assistant_text',
        text: 'hello world'
      })
    })

    it('carries a thinking heartbeat through as traffic, with no words in it', () => {
      // ⛔ Load-bearing, not incidental. llama.cpp b10199 serving Qwen3.8-27B puts every token of a
      // reasoning phase in `reasoning_content` and leaves `content` empty (measured 2026-09-04), so
      // without this record the stream is silent while the model works — and the quality review's
      // silence clock kills it (t217). ⚠️ A count, never the chain of thought: the reply is read by
      // finding a JSON object in it, and draft JSON in the thinking would be picked up as an answer.
      expect(decode({ type: 'thinking', chars: 120 })).toEqual({ kind: 'other', type: 'thinking' })
    })

    it('decodes usage records with final flag', () => {
      expect(
        decode({
          type: 'usage',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            thinking_tokens: 10,
            cache_read_tokens: 20,
            cache_write_tokens: 30
          },
          final: true
        })
      ).toEqual({
        kind: 'usage',
        usage: {
          input: 100,
          output: 50,
          thinking: 10,
          cacheRead: 20,
          cacheWrite: 30
        },
        final: true
      })
    })

    it('decodes result record for SUCCESS and ERROR', () => {
      expect(decode({ type: 'result', text: 'Completed successfully', status: 'SUCCESS' })).toEqual({
        kind: 'result',
        text: 'Completed successfully',
        costUsd: null,
        isError: false,
        terminalReason: 'SUCCESS'
      })

      expect(decode({ type: 'result', text: 'Something failed', status: 'ERROR' })).toEqual({
        kind: 'result',
        text: 'Something failed',
        costUsd: null,
        isError: true,
        terminalReason: 'ERROR'
      })
    })

    it('decodes tool_result for task_complete as terminal result', () => {
      expect(
        decode({ type: 'tool_result', tool: 'task_complete', summary: 'Implemented all features' })
      ).toEqual({
        kind: 'result',
        text: 'Implemented all features',
        costUsd: null,
        isError: false,
        terminalReason: 'task_complete'
      })
    })

    it('decodes tool_result for ask_human as blocked turn_status', () => {
      expect(
        decode({
          type: 'tool_result',
          tool: 'ask_human',
          question: 'Should we use sqlite or postgres?',
          options: ['sqlite', 'postgres']
        })
      ).toEqual({
        kind: 'turn_status',
        category: 'blocked',
        detail: 'Should we use sqlite or postgres?',
        needsAction: 'Should we use sqlite or postgres?'
      })
    })

    it('returns other for unknown record types and null for non-objects', () => {
      expect(decode({ type: 'unknown_type' })).toEqual({ kind: 'other', type: 'unknown_type' })
      expect(decode(null as never)).toBeNull()
      expect(decode('not an object' as never)).toBeNull()
    })
  })
})

describe('local-llm probeIdentity against mock HTTP server', () => {
  const ad = adapter('local-llm')
  let server: Server
  let port: number
  let serverHandler: (url: string, res: import('node:http').ServerResponse) => void

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (serverHandler) serverHandler(req.url ?? '', res)
      else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (typeof addr === 'object' && addr) port = addr.port
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('returns loggedIn: true and model names when /v1/models responds with 200', async () => {
    serverHandler = (url, res) => {
      if (url.includes('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'qwen3-coder-30b' }, { id: 'deepseek-coder' }] }))
      }
    }

    const probe = await ad.probeIdentity(`http://127.0.0.1:${port}`)
    expect(probe.loggedIn).toBe(true)
    expect(probe.cliVersion).toBe('1.0.0')
    expect(probe.account).toBe('local')
    expect(probe.organization).toBe('models: qwen3-coder-30b, deepseek-coder')
  })

  it('returns loggedIn: false when /v1/models returns HTTP error', async () => {
    serverHandler = (_url, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Internal server error')
    }

    const probe = await ad.probeIdentity(`http://127.0.0.1:${port}`)
    expect(probe.loggedIn).toBe(false)
    expect(probe.account).toBeUndefined()
    expect(probe.organization).toContain('HTTP 500')
  })

  it('returns loggedIn: false when endpoint is completely unreachable', async () => {
    const probe = await ad.probeIdentity('http://127.0.0.1:1')
    expect(probe.loggedIn).toBe(false)
    expect(probe.account).toBeUndefined()
    expect(probe.organization).toMatch(/connect|ECONNREFUSED/i)
  })
})

/**
 * ⛔ The bridge is spawned **as TypeScript source** by the suite below — `node
 * --experimental-strip-types`, which strips types and resolves nothing else. It has no idea what
 * `@shared` is, so an import through the alias kills the child before it emits its `init` record and
 * every check below then waits out its full 15s timeout and reports as *slow*, never as *broken*.
 *
 * ⚠️ This check exists because that is exactly what happened (2026-09-07): `errorMessage` was
 * factored out of 91 call sites, one of them was here, and the result was seven timeouts and no
 * error message anywhere. It costs one file read and it names the rule, which the timeouts did not.
 */
describe('what the bridge is allowed to import', () => {
  it('reaches for nothing through the @shared alias', () => {
    const source = readFileSync(join(__dirname, 'local-llm-bridge.ts'), 'utf8')
    const offenders = source
      .split(/\r?\n/)
      .filter((line) => line.startsWith('import ') && line.includes('@shared'))
    expect(offenders, 'the bridge runs under --experimental-strip-types; copy it in instead').toEqual(
      []
    )
  })
})

describe('local-llm-bridge process integration with mock OpenAI SSE endpoint', () => {
  let server: Server
  let port: number
  let completionsHandler: (body: Record<string, unknown>, res: import('node:http').ServerResponse) => void

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.includes('/v1/chat/completions')) {
        let raw = ''
        req.on('data', (d: Buffer) => { raw += d.toString() })
        req.on('end', () => {
          let body = {}
          try {
            body = JSON.parse(raw) as Record<string, unknown>
          } catch {
            // ignore
          }
          completionsHandler(body, res)
        })
      } else {
        res.writeHead(404)
        res.end()
      }
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (typeof addr === 'object' && addr) port = addr.port
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function runBridge(envOverrides: Record<string, string> = {}) {
    const ts = join(__dirname, 'local-llm-bridge.ts')
    const compiled = join(REPO, 'out/main/local-llm-bridge.js')
    const bridgeScript = existsSync(ts) ? ts : compiled
    const args = bridgeScript.endsWith('.ts') ? ['--experimental-strip-types', bridgeScript] : [bridgeScript]
    const child = spawn(
      process.execPath,
      args,
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          LOCAL_LLM_ENDPOINT: `http://127.0.0.1:${port}`,
          LOCAL_LLM_MODEL: 'test-model',
          ...envOverrides
        },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )

    const lines: Array<Record<string, unknown>> = []
    child.stderr.on('data', (d: Buffer) => {
      process.stderr.write(`[BRIDGE STDERR] ${d.toString()}`)
    })
    const rl = createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      try {
        lines.push(JSON.parse(line.trim()) as Record<string, unknown>)
      } catch {
        // ignore non-json
      }
    })

    return { child, lines }
  }

  it('streams response chunks, reports server usage, and completes turn', async () => {
    completionsHandler = (body, res) => {
      expect(body.stream_options).toEqual({ include_usage: true })
      expect(body.stream).toBe(true)

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })

      // Delta 1
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] })}\n\n`)
      // Delta 2
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'world!' } }] })}\n\n`)
      // Usage chunk
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`)
      // Done
      res.write('data: [DONE]\n\n')
      res.end()
    }

    const { child, lines } = runBridge()

    // Send a prompt
    child.stdin.write(JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n')

    // Wait for the result line
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (lines.some((l) => l.type === 'result')) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    child.stdin.end()
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))

    // Assert emitted sequence
    expect(lines.find((l) => l.type === 'init')).toMatchObject({ type: 'init', model: 'test-model' })
    expect(lines.filter((l) => l.type === 'assistant_text').map((l) => l.text).join('')).toBe('Hello world!')

    const usageRecord = lines.find((l) => l.type === 'usage') as { type: string; usage: { input_tokens: number; output_tokens: number }; final: boolean } | undefined
    expect(usageRecord).toBeDefined()
    expect(usageRecord?.usage.input_tokens).toBe(10)
    expect(usageRecord?.usage.output_tokens).toBe(5)
    expect(usageRecord?.final).toBe(true)

    const resultRecord = lines.find((l) => l.type === 'result')
    expect(resultRecord).toMatchObject({ type: 'result', text: 'Hello world!', status: 'SUCCESS' })
  })

  it('reports a thinking model as working, and keeps its reasoning out of the answer', async () => {
    // ⛔ The measured shape of llama.cpp b10199 serving Qwen3.8-27B (2026-09-04): every token of the
    // reasoning phase arrives as `reasoning_content` with `content` empty. Read by nothing, that is
    // a stream that says nothing while the model works — which is what killed t217's review twice.
    completionsHandler = (_body, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })
      const thought = 'I should check the diff and score it against the rubric. '
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '', reasoning_content: thought } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '', reasoning_content: thought } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"ok":true}' } }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }

    const { child, lines } = runBridge()
    child.stdin.write(JSON.stringify({ type: 'user', message: { content: 'grade this' } }) + '\n')
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (lines.some((l) => l.type === 'result')) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })
    child.stdin.end()
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))

    const thinking = lines.filter((l) => l.type === 'thinking')
    expect(thinking.length).toBeGreaterThan(0)
    expect(thinking[0]).toMatchObject({ type: 'thinking' })
    expect(typeof thinking[0]?.chars).toBe('number')

    // ⛔ And not one word of it in the answer: the reply is read by finding a JSON object, and a
    // model musing about JSON must not be able to be mistaken for one.
    const said = lines.filter((l) => l.type === 'assistant_text').map((l) => l.text).join('')
    expect(said).toBe('{"ok":true}')
    expect(said).not.toContain('rubric')
    expect(lines.find((l) => l.type === 'result')).toMatchObject({ text: '{"ok":true}' })
  })

  it('calculates fallback usage when server does not emit usage chunks', async () => {
    completionsHandler = (_body, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })

      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Estimated response tokens.' } }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }

    const { child, lines } = runBridge()

    child.stdin.write(JSON.stringify({ type: 'user', message: { content: 'Please generate some text' } }) + '\n')

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (lines.some((l) => l.type === 'result')) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    child.stdin.end()
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))

    const usageRecord = lines.find((l) => l.type === 'usage') as { type: string; usage: { input_tokens: number; output_tokens: number }; final: boolean } | undefined
    expect(usageRecord).toBeDefined()
    expect(usageRecord?.usage.input_tokens).toBeGreaterThan(0)
    expect(usageRecord?.usage.output_tokens).toBeGreaterThan(0)
    expect(usageRecord?.final).toBe(true)
  })

  it('handles task_complete tool calls from the model', async () => {
    let callCount = 0
    completionsHandler = (_body, res) => {
      callCount++
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })

      if (callCount === 1) {
        // Model calls task_complete
        res.write(`data: ${JSON.stringify({
          choices: [{
            delta: {
              content: 'All tasks are done.',
              tool_calls: [{
                index: 0,
                id: 'call_1',
                function: { name: 'task_complete', arguments: JSON.stringify({ summary: 'Finished everything cleanly' }) }
              }]
            }
          }]
        })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      }
    }

    const { child, lines } = runBridge()
    child.stdin.write('Complete the task\n')

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (lines.some((l) => l.type === 'tool_result' && l.tool === 'task_complete')) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    child.stdin.end()
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))

    const toolResult = lines.find((l) => l.type === 'tool_result')
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      tool: 'task_complete',
      summary: 'Finished everything cleanly'
    })
  })

  it('handles ask_human tool calls from the model', async () => {
    let callCount = 0
    completionsHandler = (_body, res) => {
      callCount++
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })

      if (callCount === 1) {
        // Model calls ask_human
        res.write(`data: ${JSON.stringify({
          choices: [{
            delta: {
              content: 'I need clarification.',
              tool_calls: [{
                index: 0,
                id: 'call_q',
                function: {
                  name: 'ask_human',
                  arguments: JSON.stringify({
                    question: 'Do you want Option A or Option B?',
                    options: ['Option A', 'Option B']
                  })
                }
              }]
            }
          }]
        })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      } else {
        // Model continues after tool result
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Waiting for answer' } }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      }
    }

    const { child, lines } = runBridge()
    child.stdin.write('Ask a question\n')

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (lines.some((l) => l.type === 'tool_result' && l.tool === 'ask_human')) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    child.stdin.end()
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))

    const toolResult = lines.find((l) => l.type === 'tool_result' && l.tool === 'ask_human')
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      tool: 'ask_human',
      question: 'Do you want Option A or Option B?',
      options: ['Option A', 'Option B']
    })
  })

  it('handles HTTP error by emitting ERROR result record', async () => {
    completionsHandler = (_body, res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Server out of memory')
    }

    const { child, lines } = runBridge()
    child.stdin.write('trigger error\n')

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (lines.some((l) => l.type === 'result' && l.status === 'ERROR')) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    child.stdin.end()
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))

    const errorResult = lines.find((l) => l.type === 'result' && l.status === 'ERROR')
    expect(errorResult).toBeDefined()
    expect(errorResult?.text).toContain('HTTP 500')
  })

  it('runs without tools in read-only permission mode (quality review)', async () => {
    let receivedTools: unknown = 'initial'
    completionsHandler = (body, res) => {
      receivedTools = body.tools
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })

      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: JSON.stringify({ summary: 'LGTM', scores: { fidelity: { score: 9 } } }) } }]
      })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }

    const { child, lines } = runBridge({ LOCAL_LLM_PERMISSION_MODE: 'read-only' })
    child.stdin.write('review this diff\n')

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (lines.some((l) => l.type === 'result')) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    child.stdin.end()
    await new Promise<void>((resolve) => child.on('exit', () => resolve()))

    expect(receivedTools).toBeUndefined()
    const resultRecord = lines.find((l) => l.type === 'result')
    expect(resultRecord).toMatchObject({
      type: 'result',
      status: 'SUCCESS'
    })
    expect(resultRecord?.text).toContain('LGTM')
  })
})
