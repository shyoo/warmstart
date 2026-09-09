import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ApiContext } from '../api.js'
import { buildApi } from '../api.js'
import type { DaemonEvent, RemoteBind, RemotePushSubscription, RpcRequest, RpcResponse } from '@shared/protocol.js'
import { errorMessage } from '@shared/errors.js'
import { getTask } from '../tasks.js'
import { requireQuestion } from '../questions.js'
import { requireApproval } from '../approvals.js'
import { remoteConfig, onRemoteConfigChange, remoteProjects, setRemoteListenerInfo } from './config.js'
import { verifyDevice, touchDevice } from './devices.js'
import { redeemPairingCode } from './pairing.js'
import { createPushDispatcher, subscribePush } from './push.js'
import { REMOTE_EVENT_CLASS, REMOTE_FILTERED, REMOTE_METHODS, eventSocketToken, remoteEventTaskId, remoteScopeOf, type RemoteAllowedMethod } from './policy.js'
import { tailscaleInfo, type TailscaleInfo } from './tailscale.js'
import { log } from '../log.js'

const MAX_BODY_BYTES = 4 * 1024 * 1024
const failures = new Map<string, number[]>()
interface RemoteServer { close(): Promise<void>; broadcast(event: DaemonEvent): void }

export function startRemoteServer(ctx: ApiContext): { close(): Promise<void>; broadcast(event: DaemonEvent): void } {
  let live: RemoteServer | null = null
  let info: TailscaleInfo | null = null
  const publish = () => setRemoteListenerInfo(() => ({ listening: !!live, secure: !!live && secure(remoteConfig().bind, info), urls: urls(), tailscale: info ? { installed: info.installed, hostname: info.hostname, certAvailable: info.certAvailable } : null }))
  const urls = () => {
    if (!live) return []
    const c = remoteConfig(), scheme = secure(c.bind, info) ? 'https' : 'http'
    const out: string[] = []
    if ((c.bind === 'tailscale' || c.bind === 'both') && info?.hostname) out.push(`${scheme}://${info.hostname}:${c.port}`)
    // ⛔ The machine's own LAN addresses, never `localhost`: this list is what gets typed into a
    // phone, and `localhost` there is the phone.
    if (c.bind === 'lan' || c.bind === 'both') for (const address of lanAddresses()) out.push(`${scheme}://${address}:${c.port}`)
    return out
  }
  const refresh = async () => {
    if (live) { await live.close(); live = null }
    if (!remoteConfig().enabled) return publish()
    info = await tailscaleInfo()
    const c = remoteConfig()
    if (c.bind === 'tailscale' && !info.ipv4) { log.warn('remote access not listening: Tailscale is unavailable'); return publish() }
    try { live = await listen(ctx, info); publish() } catch (err) { log.warn(`remote access could not bind port ${c.port}: ${errorMessage(err)}`); publish() }
  }
  const off = onRemoteConfigChange(() => { void refresh() })
  void refresh()
  // ⛔ Notifications are gated on the *setting*, not on `live`. A phone that is asleep on another
  // network has no event socket — waking it is the whole point — so a listener that happens to be
  // rebinding must not silently swallow the one alert the operator was waiting for.
  const push = createPushDispatcher({ enabled: () => remoteConfig().enabled, visible: remotelyVisible })
  return {
    async close() { off(); if (live) await live.close(); live = null; setRemoteListenerInfo(null) },
    broadcast(event) { live?.broadcast(event); push.deliver(event) }
  }
}

/**
 * Whether this listener speaks TLS.
 *
 * ⛔ Only when the tailnet hostname is one of the addresses being offered. Tailscale issues its
 * certificate for `host.tailnet.ts.net` and nothing else, so presenting it on a bare LAN address
 * is a name mismatch every browser refuses — worse than plain HTTP, because it fails after the
 * operator has already been told the connection is encrypted.
 */
function secure(bind: RemoteBind, ts: TailscaleInfo | null): boolean {
  return bind !== 'lan' && !!ts?.certAvailable
}

/**
 * Whether an event may leave this machine at all — the per-project switch, applied once for both
 * routes out. ⛔ Two copies of this drifted apart is exactly how a phone would end up notified
 * about a project the operator had not exposed.
 */
function remotelyVisible(event: DaemonEvent): boolean {
  const cls = REMOTE_EVENT_CLASS[event.type]
  if (cls === 'never') return false
  if (cls === 'fleet') return true
  const taskId = remoteEventTaskId(event)
  return !!taskId && projectEnabledForTask(taskId)
}

async function listen(ctx: ApiContext, ts: TailscaleInfo): Promise<RemoteServer> {
  const c = remoteConfig(), api = buildApi(ctx), clients = new Map<WebSocket, string>()
  const handler = (req: IncomingMessage, res: ServerResponse) => void handle(req, res, api)
  const server: Server = secure(c.bind, ts) && ts.certPath && ts.keyPath ? createHttpsServer({ cert: readFileSync(ts.certPath), key: readFileSync(ts.keyPath) }, handler) : createHttpServer(handler)
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    // ⛔ Header first, `?token=` second: browsers cannot set headers on a WebSocket handshake,
    // so the served phone app has no other way to authenticate. `verifyDevice` only ever sees a
    // token, never which of the two carried it.
    const headers = req.headers as unknown as Record<string, string | string[] | undefined>
    const authorization = headers.authorization
    const presented = eventSocketToken(
      Array.isArray(authorization) ? authorization[0] : authorization,
      req.url
    )
    const id = presented ? verifyDevice(presented)?.id ?? null : null
    const pathname = req.url?.split('?')[0] ?? ''
    if (pathname !== '/remote/events' || !id) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return }
    touchDevice(id, addressOf(req)); wss.handleUpgrade(req, socket, head, (ws) => { clients.set(ws, id); ws.on('close', () => clients.delete(ws)); ws.on('error', () => clients.delete(ws)) })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(c.port, c.bind === 'tailscale' ? ts.ipv4! : '0.0.0.0', resolve) })
  return { close: () => new Promise((resolve) => { for (const ws of clients.keys()) ws.terminate(); wss.close(); server.close(() => resolve()) }), broadcast(event) { if (!remotelyVisible(event)) return; const payload = JSON.stringify(event); for (const ws of clients.keys()) if (ws.readyState === 1) ws.send(payload) } }
  async function handle(req: IncomingMessage, res: ServerResponse, handlers: ReturnType<typeof buildApi>) {
    const send = (status: number, body: unknown) => { const payload = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }); res.end(payload) }
    if (req.method === 'POST' && req.url === '/remote/pair') { const address = addressOf(req); const body = await bodyOf(req); if (!body || limited(address)) return send(body ? 429 : 400, { error: body ? 'too many pairing attempts' : 'malformed json' }); const p = body as { code?: string; label?: string }; if (!p.code || !p.label) return send(400, { error: 'code and label required' }); const pair = redeemPairingCode(p.code, p.label, address); if (!pair) { fail(address); return send(401, { error: 'invalid pairing code' }) }; return send(200, { token: pair.token, deviceId: pair.device.id }) }
    // ⛔ The app shell is public on purpose: the pair screen, manifest, icons and service worker
    // must load before any token exists — and browsers fetch all four without custom headers, so
    // gating them would break pairing and installability, not protect anything. There is nothing
    // per-device in the built files; everything under `/remote/` stays token-gated.
    if (!(req.url ?? '').startsWith('/remote/')) return staticFile(req, res)
    const device = authenticate(req); if (!device) return send(401, { error: 'unauthorized' }); touchDevice(device, addressOf(req))
    if (req.method === 'GET' && req.url === '/remote/health') return send(200, { ok: true })
    if (req.method === 'POST' && req.url === '/remote/rpc') {
      const parsed = await bodyOf(req)
      if (!parsed || typeof parsed !== 'object') return send(400, { error: 'malformed json' })
      const request = parsed as RpcRequest
      const method = request.method
      if (!(method in REMOTE_METHODS)) return send(404, { error: 'unknown method' })
      if (REMOTE_METHODS[method] === 'deny') return send(403, { error: `remote access denied for '${method}'` })
      // Narrowed by the line above: everything left is in `REMOTE_SCOPES` by construction.
      const allowed = method as RemoteAllowedMethod
      // ⚠️ 404, not 403: a project this device may not see should not be distinguishable from one
      // that does not exist.
      if (!inScope(allowed, request.params)) return send(404, { error: 'not found' })
      try {
        // ⛔ The one method that needs to know *who* is calling: a push subscription belongs to the
        // device that made it, so that revoking the device takes its notifications with it.
        if (allowed === 'remote.subscribe') {
          subscribePush(device, request.params as RemotePushSubscription)
          return send(200, { id: request.id, ok: true, result: { ok: true } } satisfies RpcResponse)
        }
        const raw = await (handlers[allowed] as (p: unknown) => unknown)(request.params)
        return send(200, { id: request.id, ok: true, result: withinRemoteProjects(allowed, raw) } satisfies RpcResponse)
      } catch (err) {
        return send(200, { id: request.id, ok: false, error: { message: errorMessage(err) } } satisfies RpcResponse)
      }
    }
    return staticFile(req, res)
  }
}
/**
 * Every IPv4 address a phone on the same network could reach this machine at.
 *
 * ⚠️ Tailscale's own `100.64/10` addresses are excluded: they are offered under the tailnet
 * hostname, with its certificate, and listing the bare IP as well would offer the same machine
 * twice — once as the encrypted address and once as one that cannot be.
 */
function lanAddresses(): string[] {
  const usable = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address)
    // ⛔ 100.64/10 is Tailscale's own range, already offered under the tailnet hostname with its
    // certificate; 169.254/16 is what an adapter gives itself when DHCP failed, and nothing can
    // reach it. Neither is an address worth typing into a phone.
    .filter((address) => !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) && !/^169\.254\./.test(address))
  // A private address first: it is the one the phone on the same Wi-Fi will actually reach, and the
  // first entry in this list is what the pairing QR is built from.
  const private_ = (a: string): boolean => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)
  return [...usable].sort((a, b) => Number(private_(b)) - Number(private_(a)))
}

function authenticate(req: IncomingMessage): string | null { const h = req.headers.authorization; if (!h?.startsWith('Bearer ')) return null; return verifyDevice(h.slice(7))?.id ?? null }
function addressOf(req: IncomingMessage): string { return req.socket.remoteAddress ?? 'unknown' }
async function bodyOf(req: IncomingMessage): Promise<unknown> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { size += (chunk as Buffer).length; if (size > MAX_BODY_BYTES) return null; chunks.push(chunk as Buffer) } try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null } }
function fail(address: string): void {
  const now = Date.now()
  failures.set(address, [...(failures.get(address) ?? []).filter((t) => now - t < 60_000), now])
  // The map is keyed by address and would otherwise only ever grow; an address with nothing left
  // inside its window is not being rate-limited and does not need remembering.
  for (const [seen, times] of failures) if (times.every((t) => now - t >= 60_000)) failures.delete(seen)
}
function limited(address: string): boolean { const now = Date.now(); return (failures.get(address) ?? []).filter((t) => now - t < 60_000).length >= 5 }
function projectEnabledForTask(id: string): boolean { const task = getTask(id); return !!task?.projectId && remoteProjects().has(task.projectId) }

/** Whether this call names something the operator has actually exposed. See `REMOTE_SCOPES`. */
function inScope(method: RemoteAllowedMethod, params: unknown): boolean {
  const scope = remoteScopeOf(method)
  if (scope.by === 'fleet') return true
  const named = (params && typeof params === 'object' ? (params as Record<string, unknown>)[scope.param] : undefined)
  if (scope.by === 'project') {
    // An absent optional project means "everything I may see"; the result is filtered instead.
    if (typeof named !== 'string' || named.length === 0) return !scope.required
    return remoteProjects().has(named)
  }
  if (typeof named !== 'string' || named.length === 0) return false
  if (scope.by === 'task') return projectEnabledForTask(named)
  try {
    // ⚠️ A question or approval with no task behind it (a consult, a chat) has no project, so it
    // has nothing the per-project switch could have enabled. Refused rather than assumed open.
    const taskId = scope.by === 'question' ? requireQuestion(named).taskId : requireApproval(named).taskId
    return !!taskId && projectEnabledForTask(taskId)
  } catch {
    return false
  }
}

/** Cut a fleet-wide result down to the enabled projects. See `REMOTE_FILTERED`. */
function withinRemoteProjects(method: RemoteAllowedMethod, result: unknown): unknown {
  if (method === 'task.list') {
    const enabled = remoteProjects()
    return (result as Array<{ projectId: string | null }>).filter((t) => !!t.projectId && enabled.has(t.projectId))
  }
  const key = (REMOTE_FILTERED as Partial<Record<RemoteAllowedMethod, string>>)[method]
  if (!key || !Array.isArray(result)) return result
  return (result as Array<Record<string, unknown>>).filter((rowValue) => {
    const taskId = rowValue[key]
    return typeof taskId === 'string' && projectEnabledForTask(taskId)
  })
}
function mobileBase(): string {
  // ⛔ The bundle this file ships in decides the relative path: the packaged daemon is one file
  // at `out/main/orchestratord.js`, so `../mobile` is `out/mobile`. Fall back to the older
  // `../../mobile` layout rather than 503ing on a packaging detail, and anchor on `index.html` —
  // a directory without it is never the app, whatever the layout claims.
  const here = dirname(fileURLToPath(import.meta.url))
  for (const rel of ['../mobile', '../../mobile']) {
    const base = join(here, rel)
    try {
      if (existsSync(join(base, 'index.html'))) return base
    } catch { /* a sibling that cannot be read is not the app either */ }
  }
  return join(here, '../mobile')
}
/**
 * ⛔ `startsWith(base)` is not containment: `base` has no trailing separator, so `../mobileprivate`
 * normalises to a sibling directory whose path still starts with it. The separator is the check.
 */
function withinBase(base: string, file: string): boolean {
  return file === base || file.startsWith(base.endsWith(sep) ? base : base + sep)
}

function staticFile(req: IncomingMessage, res: ServerResponse): void {
  const base = mobileBase()
  if (!existsSync(base)) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('mobile app has not been built'); return }
  const pathname = new URL(req.url ?? '/', 'http://remote').pathname
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  const file = normalize(join(base, requested))
  // Anything outside the bundle, and anything missing, is the SPA shell — hash routes never hit disk.
  const target = withinBase(base, file) && existsSync(file) ? file : join(base, 'index.html')
  res.writeHead(200, { 'content-type': staticContentType(target) })
  res.end(readFileSync(target))
}

/** Vite emits module scripts; browsers refuse those unless the static response names JavaScript. */
function staticContentType(file: string): string {
  const suffix = file.slice(file.lastIndexOf('.')).toLowerCase()
  if (suffix === '.js') return 'text/javascript; charset=utf-8'
  if (suffix === '.css') return 'text/css; charset=utf-8'
  if (suffix === '.json' || suffix === '.webmanifest') return 'application/manifest+json; charset=utf-8'
  if (suffix === '.svg') return 'image/svg+xml'
  if (suffix === '.png') return 'image/png'
  return 'text/html; charset=utf-8'
}
