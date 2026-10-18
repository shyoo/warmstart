import http from 'node:http'
import { readFileSync } from 'node:fs'
import type { RpcMethod, RpcParams, RpcResponse, RpcResult } from '@shared/protocol.js'
import { appEnv } from '@shared/env.js'
import { errorMessage } from '@shared/errors.js'
import { workerTools, type WorkerToolIo } from '../mcp/workertools.js'
import { parseArgs, toolHelp, toolNamed, usage, validateArgs } from './args.js'

/**
 * `warmstart-agent`: Warmstart's worker tools as a shell command.
 *
 * Run by an agent whose CLI has no MCP, through the shim the daemon put on that session's PATH
 * (`agentcli.ts` in the daemon). It holds no state and decides nothing: it turns a command line into
 * the same tool call `src/mcp/workertools.ts` defines, and sends the RPC to orchestratord's `/agent`
 * door with the session's own token.
 *
 * ⛔ **Never the daemon's token.** It reads `WARMSTART_AGENT_TOKEN` and `WARMSTART_AGENT_URL` and
 * nothing else — not `orchestratord.json` — so what an agent can do with it is exactly what the
 * daemon lets that one token do.
 *
 * ⚠️ Exit codes: 0 the tool answered, 1 the tool answered with a refusal or failure, 2 the command
 * line was wrong or the helper could not run at all. The text on stdout is the answer either way.
 */

const tools = workerTools(makeIo())

function makeIo(): WorkerToolIo {
  const call = <M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>> =>
    post(method, params) as Promise<RpcResult<M>>
  return { sessionId: '', rpc: call, held: (_extra, method, params) => call(method, params) }
}

function post(method: string, params: unknown): Promise<unknown> {
  const url = appEnv('AGENT_URL')
  const token = appEnv('AGENT_TOKEN')
  if (!url || !token) {
    return Promise.reject(
      new Error(
        'warmstart-agent only works inside an agent session Warmstart started: this shell has no ' +
          'WARMSTART_AGENT_URL / WARMSTART_AGENT_TOKEN. Use the TASK COMPLETE: / NEEDS DECISION: lines instead.'
      )
    )
  }
  const target = new URL(url)
  const data = JSON.stringify({ id: Date.now(), method, params })
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          authorization: `Bearer ${token}`
        },
        timeout: 0
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as RpcResponse
            if (!parsed.ok) reject(new Error(parsed.error.message))
            else resolve(parsed.result)
          } catch {
            reject(new Error(`Warmstart answered ${res.statusCode ?? '?'} with something that is not JSON`))
          }
        })
      }
    )
    req.on('error', (err) => reject(new Error(`could not reach Warmstart at ${url}: ${errorMessage(err)}`)))
    req.write(data)
    req.end()
  })
}

function readArgsFile(path: string): Record<string, unknown> {
  const raw = path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8')
  // A file saved by PowerShell 5 starts with a byte-order mark, which JSON.parse refuses.
  const parsed: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--args-file must hold one JSON object of arguments')
  }
  return parsed as Record<string, unknown>
}

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv
  if (!first || first === 'help' || first === '--help' || first === '-h') {
    const named = first === 'help' && rest[0] ? toolNamed(tools, rest[0]) : undefined
    if (first === 'help' && rest[0] && !named) {
      process.stdout.write(`No tool called '${rest[0]}'.\n\n${usage(tools)}\n`)
      return 2
    }
    process.stdout.write(`${named ? toolHelp(named) : usage(tools)}\n`)
    return 0
  }
  const tool = toolNamed(tools, first)
  if (!tool) {
    process.stdout.write(`No tool called '${first}'.\n\n${usage(tools)}\n`)
    return 2
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(`${toolHelp(tool)}\n`)
    return 0
  }

  const parsed = parseArgs(tool, rest)
  if (!parsed.ok) {
    process.stdout.write(`${parsed.error}\n`)
    return 2
  }
  let args = parsed.args
  if (parsed.argsFile) {
    try {
      args = { ...readArgsFile(parsed.argsFile), ...args }
    } catch (err) {
      process.stdout.write(`Could not read --args-file: ${errorMessage(err)}\n`)
      return 2
    }
  }
  const invalid = validateArgs(tool, args)
  if (invalid) {
    process.stdout.write(`${invalid}\n\nRun \`warmstart-agent help ${tool.name}\` for its flags.\n`)
    return 2
  }

  if (tool.name === 'task_complete' || tool.name === 'land_work') {
    process.stderr.write('Waiting for Warmstart: this can take minutes while the project checks run…\n')
  }
  const result = await tool.handler(args)
  process.stdout.write(`${result.content.map((part) => part.text).join('\n')}\n`)
  return result.isError ? 1 : 0
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stdout.write(`warmstart-agent failed: ${errorMessage(err)}\n`)
    process.exit(2)
  }
)
