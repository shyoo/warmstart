import { createServer, type IncomingMessage, type Server } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type { DaemonEvent, RpcMethod, RpcRequest, RpcResponse } from '@shared/protocol.js'
import { buildApi, type ApiContext } from './api.js'
import { log } from './log.js'
import { errorMessage } from '@shared/errors.js'

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

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        // Nothing here is meant for a browser to reach directly.
        'access-control-allow-origin': 'null'
      })
      res.end(payload)
    }

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
        try {
          const result = await handler(request.params)
          send(200, { id: request.id, ok: true, result } satisfies RpcResponse)
        } catch (err) {
          const message = errorMessage(err)
          log.warn(`rpc ${request.method} failed: ${message}`)
          send(200, { id: request.id, ok: false, error: { message } } satisfies RpcResponse)
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

  const port = await listen(server)
  context.port = port
  log.info(`orchestratord listening on 127.0.0.1:${port}`)

  return {
    server,
    port,
    broadcast(event: DaemonEvent) {
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
    },
    close() {
      for (const ws of clients) ws.terminate()
      clients.clear()
      wss.close()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
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

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return false
  const given = Buffer.from(header.slice(7))
  const expected = Buffer.from(token)
  // Length must match before timingSafeEqual, which throws on mismatched lengths.
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export type { RpcMethod }
