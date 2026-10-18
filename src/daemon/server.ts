import { createServer, type IncomingMessage, type Server } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type { DaemonEvent, RpcMethod, RpcRequest, RpcResponse } from '@shared/protocol.js'
import { buildApi, type ApiContext } from './api.js'
import { log } from './log.js'
import { errorMessage } from '@shared/errors.js'
import { daemonTimings, monitorPerformance } from './performance.js'
import {
  AGENT_ASK_ORIGINS,
  AGENT_CLI_COMMAND,
  AGENT_METHODS,
  rateLimitRefusal,
  runAsHelper,
  sessionForAgentToken,
  setAgentCliPort
} from './agentcli.js'
import { runForSession } from './tasks.js'

/**
 * The daemon's front door.
 *
 * Bound to 127.0.0.1 on a port the OS picks, behind a bearer token published alongside it. It is not
 * a public API and is not trying to be: anything that can read the endpoint file is already running
 * as the user.
 *
 * ⛔ The renderer never holds this token. It talks to the Electron main process over IPC, and main
 * is the only client. The renderer displays untrusted agent output; it does not get a credential to
 * a service that can spawn processes.
 */

const MAX_BODY_BYTES = 4 * 1024 * 1024

export interface DaemonServer {
  server: Server
  port: number
  broadcast(event: DaemonEvent): void
  close(): Promise<void>
}

export async function startServer(token: string, ctx: Omit<ApiContext, 'port'>): Promise<DaemonServer> {
  const context: ApiContext = { ...ctx, port: 0 }
  const api = buildApi(context)
  const clients = new Set<WebSocket>()
  const stopMonitor = monitorPerformance()

  const server = createServer((req, res) => {
    let method: string | null = null
    const send = (status: number, body: unknown) => {
      const start = performance.now()
      const payload = JSON.stringify(body)
      const bytes = Buffer.byteLength(payload)
      if (method) daemonTimings.record(`RPC encode ${method}`, performance.now() - start, bytes)
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        // Nothing here is meant for a browser to reach directly.
        'access-control-allow-origin': 'null'
      })
      res.end(payload)
      return bytes
    }

    // ⛔ Before the daemon's own token is checked, and never accepting it: `/agent` takes only a
    // per-session agent token, and an agent token opens nothing else. See `serveAgent`.
    if (req.url === '/agent') return serveAgent(req, send, api)

    if (!authorized(req, token)) return send(401, { error: 'unauthorized' })

    if (req.method === 'GET' && req.url === '/health') {
      return send(200, { ok: true, version: ctx.version, uptimeMs: Date.now() - ctx.startedAt })
    }
    if (req.method !== 'POST' || req.url !== '/rpc') return send(404, { error: 'not found' })

    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        send(413, { error: 'request too large' })
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      void (async () => {
        let request: RpcRequest
        try {
          request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcRequest
        } catch {
          return send(400, { error: 'malformed json' })
        }
        const handler = (api as Record<string, (p: unknown) => unknown>)[request.method]
        if (typeof handler !== 'function') {
          return send(404, {
            id: request.id,
            ok: false,
            error: { message: `unknown method '${request.method}'` }
          } satisfies RpcResponse)
        }
        method = String(request.method)
        const finish = daemonTimings.begin(`RPC total ${method}`)
        try {
          const start = performance.now()
          let pending: unknown
          try { pending = handler(request.params) }
          finally { daemonTimings.record(`RPC sync ${method}`, performance.now() - start) }
          const result = await pending
          const bytes = send(200, { id: request.id, ok: true, result } satisfies RpcResponse)
          finish(false, bytes)
        } catch (err) {
          const message = errorMessage(err)
          log.warn(`rpc ${request.method} failed: ${message}`)
          const bytes = send(200, { id: request.id, ok: false, error: { message } } satisfies RpcResponse)
          finish(true, bytes)
        }
      })()
    })
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/events' || !authorized(req, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws)
      ws.on('close', () => clients.delete(ws))
      ws.on('error', () => clients.delete(ws))
    })
  })

  applyLoopbackTimeouts(server)

  let port: number
  try { port = await listen(server) }
  catch (err) { stopMonitor(); wss.close(); throw err }
  context.port = port
  setAgentCliPort(port)
  log.info(`orchestratord listening on 127.0.0.1:${port}`)

  return {
    server,
    port,
    broadcast(event: DaemonEvent) {
      const start = performance.now()
      const payload = JSON.stringify(event)
      for (const ws of clients) {
        // readyState 1 is OPEN. Sending to a closing socket throws and would take the loop with it.
        if (ws.readyState === 1) {
          try {
            ws.send(payload)
          } catch {
            clients.delete(ws)
          }
        }
      }
      daemonTimings.record(`event ${event.type}`, performance.now() - start, Buffer.byteLength(payload))
    },
    close() {
      stopMonitor()
      for (const ws of clients) ws.terminate()
      clients.clear()
      wss.close()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

/**
 * Node's socket reapers, retuned for the one client this listener actually has.
 *
 * ⛔ **A busy daemon must make the UI slow, never broken, and until now it made it broken.**
 * `orchestratord` is single-threaded and every RPC handler is synchronous `node:sqlite` work, so a
 * heavy read blocks the event loop — and node's reapers are timers, which means they do not fire
 * *during* the block, they fire in a batch the instant it clears. Measured on this install
 * 2026-09-09 by stacking 40 `quality.queue` calls: `/health` took **78s** to answer, and one poll
 * came back `TypeError: fetch failed` / `ECONNRESET` — the badge this fixes. What reset it is
 * `keepAliveTimeout`, whose default 5s node advertises to the client as `Keep-Alive: timeout=5`:
 * undici subtracts its own safety threshold and re-uses the socket believing 5s is when the server
 * *will* close, while a blocked loop means 5s is only when the server *starts wanting to*. The
 * request goes out onto a socket the server destroys as soon as it can run a timer again.
 *
 * ⛔ **Raising these is safe here and only here.** `headersTimeout`/`requestTimeout` exist to stop a
 * hostile client holding sockets open by dribbling a request; this server is bound to 127.0.0.1
 * behind a bearer token, and its only client is the Electron main process in the same session — so
 * they defend against nothing and can only fire on our own slowness. ⚠️ **Not for the remote
 * listener** (`src/daemon/remote/`), which is reachable from a tailnet and keeps node's defaults.
 *
 * ⭐ The cure for the *cause* is that no RPC should block the loop for 78s; see `isTaskGradable`.
 * This is the belt: the failure it removes is one where the work succeeded and the answer was
 * thrown away in transit.
 */
export function applyLoopbackTimeouts(server: Server): void {
  // Longer than any client's idle window, so the client is always the side that closes and the
  // race above cannot happen. Node's own guidance for a server behind something that pools.
  server.keepAliveTimeout = 75_000
  // 0 disables. Node checks both on a 30s sweep that runs late for exactly as long as we were busy.
  server.headersTimeout = 0
  server.requestTimeout = 0
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // Port 0: the OS picks a free one and we publish it. No fixed port to collide with anything.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') resolve(address.port)
      else reject(new Error('server did not bind to a port'))
    })
  })
}

/**
 * The `warmstart-agent` helper's door: the worker tier, for one session, while it has a run.
 *
 * ⛔ **Four refusals before any handler runs**, each answered in a sentence the agent can act on:
 * a token minted for no live session; a session with no open run (the run already ended, by
 * `task_complete`, `await_human` or a deferred question, so the token is spent until the next
 * run); a method outside `AGENT_METHODS`; and too many calls this minute. Then `sessionId` is
 * written from the token — whatever the caller put there is discarded — and the handler runs inside
 * `runAsHelper`, which is how a wait on a person becomes a deferred card. See `agentcli.ts`.
 */
function serveAgent(
  req: IncomingMessage,
  send: (status: number, body: unknown) => number,
  api: ReturnType<typeof buildApi>
): void {
  const refuse = (id: unknown, message: string, status = 200): void => {
    send(status, { id, ok: false, error: { message } })
  }
  if (req.method !== 'POST') return refuse(null, 'not found', 404)
  const header = req.headers.authorization
  const sessionId = header?.startsWith('Bearer ') ? sessionForAgentToken(header.slice(7)) : null
  if (!sessionId) {
    return refuse(
      null,
      `${AGENT_CLI_COMMAND} is not authorised here: its token belongs to no live Warmstart session. ` +
        'It works only inside the session Warmstart started it in.',
      401
    )
  }

  const chunks: Buffer[] = []
  let size = 0
  req.on('data', (c: Buffer) => {
    size += c.length
    if (size > MAX_BODY_BYTES) {
      send(413, { error: 'request too large' })
      req.destroy()
      return
    }
    chunks.push(c)
  })
  req.on('end', () => {
    void (async () => {
      let request: RpcRequest
      try {
        request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcRequest
      } catch {
        return refuse(null, 'malformed json', 400)
      }
      const method = String(request.method) as RpcMethod
      if (!AGENT_METHODS.has(method)) {
        return refuse(request.id, `${method} is not a worker tool and is not reachable from ${AGENT_CLI_COMMAND}.`)
      }
      if (!runForSession(sessionId)) {
        return refuse(
          request.id,
          'This session has no open run, so there is nothing to act for: the run already ended — by ' +
            'task_complete, await_human, or a question filed for a person. STOP HERE; you will be started ' +
            'again if there is more to do.'
        )
      }
      const params: Record<string, unknown> = { ...((request.params ?? {}) as Record<string, unknown>), sessionId }
      if (method === 'question.ask' && !AGENT_ASK_ORIGINS.has(String(params.origin))) {
        return refuse(request.id, `A question from ${AGENT_CLI_COMMAND} may only be an ask_human or a checkpoint.`)
      }
      const limited = rateLimitRefusal(sessionId)
      if (limited) return refuse(request.id, limited)

      const handler = (api as Record<string, (p: unknown) => unknown>)[method]
      if (typeof handler !== 'function') return refuse(request.id, `unknown method '${method}'`, 404)
      try {
        const result = await runAsHelper(sessionId, () => handler(params))
        send(200, { id: request.id, ok: true, result } satisfies RpcResponse)
      } catch (err) {
        const message = errorMessage(err)
        log.warn(`agent rpc ${method} failed: ${message}`)
        send(200, { id: request.id, ok: false, error: { message } } satisfies RpcResponse)
      }
    })()
  })
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return false
  const given = Buffer.from(header.slice(7))
  const expected = Buffer.from(token)
  // Length must match before timingSafeEqual, which throws on mismatched lengths.
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export type { RpcMethod }
