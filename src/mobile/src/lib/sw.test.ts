import { describe, expect, it, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * ⛔ **The phone is reached over a tailnet relay, and the shell used to insist on the network
 * anyway.** Reported 2026-09-09: the installed app opened instantly on the home LAN and showed a
 * spinner and then the browser's network-error page from cellular. Measured from `shyoo-12700k` at
 * the time — the daemon answered `https://…ts.net:8787/` in **7.8ms** locally, MagicDNS returned an
 * A record and no AAAA, and `tailscale ping` to the phone reported *"direct connection not
 * established"* with **324ms–1.0s** round trips over a DERP relay. Nothing was down; the path was
 * slow, which off the LAN is the ordinary case and not a fault to chase.
 *
 * What turned slow into dead is this file's subject: the navigation branch of the fetch handler was
 * a bare `await fetch()` with no deadline, no `catch` and no fallback, so `respondWith` received a
 * rejected promise and the cached shell two lines above was never consulted. What it was waiting on
 * is `index.html`, **1,170 bytes** — the 224KB bundle beside it is fingerprinted and was already
 * served cache-first. The app refused to open over a round trip, not a download.
 *
 * ⚠️ Below are the four outcomes of that race, which is the whole reason this exists: a race that is
 * wrong in one direction hangs, and wrong in the other pins a phone to the build it first cached.
 *
 * ⛔ The worker is *evaluated*, not imported. It is a classic script that reaches for `self`,
 * `caches` and `fetch` as globals; handing those in as parameters keeps the fakes out of
 * `globalThis`, where a leak would be inherited by whatever suite ran next.
 */

const SOURCE = readFileSync(fileURLToPath(new URL('../../public/sw.js', import.meta.url)), 'utf8')

const ORIGIN = 'https://shyoo-12700k.taild143f.ts.net:8787'

/** The deadline in `sw.js`. ⚠️ Asserted against the source below, so this copy cannot drift. */
const DEADLINE_MS = 2500

interface FakeResponse {
  ok: boolean
  body: string
  clone: () => FakeResponse
}

const response = (body: string, ok = true): FakeResponse => ({ ok, body, clone: () => response(body, ok) })

interface FakeRequest {
  url: string
  method: string
  mode: string
}

interface FakeEvent {
  request: FakeRequest
  respondWith: (value: Promise<FakeResponse>) => void
  waitUntil: (value: Promise<unknown>) => void
}

type Handler = (event: FakeEvent) => void

/** The three globals `sw.js` reaches for, handed in as parameters rather than left on `globalThis`. */
type SwScript = (
  self: {
    addEventListener: (type: string, handler: Handler) => void
    location: { origin: string; href: string }
    skipWaiting: () => Promise<void>
    clients: { claim: () => Promise<void>; matchAll: () => Promise<never[]> }
    registration: { showNotification: () => Promise<void> }
  },
  caches: {
    open: () => Promise<unknown>
    match: (request: FakeRequest | string) => Promise<FakeResponse | undefined>
    keys: () => Promise<string[]>
    delete: () => Promise<boolean>
  },
  fetch: (request: FakeRequest) => Promise<FakeResponse>
) => void

function load(): {
  fetchHandler: Handler
  cache: Map<string, FakeResponse>
  fetched: string[]
  setNetwork: (impl: (url: string) => Promise<FakeResponse>) => void
} {
  const handlers = new Map<string, Handler>()
  const cache = new Map<string, FakeResponse>()
  const fetched: string[] = []
  let network: (url: string) => Promise<FakeResponse> = () => Promise.reject(new Error('offline'))

  /** `caches` keys on a URL; `sw.js` passes it both a request and a relative string. */
  const key = (request: FakeRequest | string): string =>
    typeof request === 'string' ? new URL(request, `${ORIGIN}/sw.js`).href : request.url

  const store = {
    put: (request: FakeRequest | string, value: FakeResponse) => {
      cache.set(key(request), value)
      return Promise.resolve()
    },
    addAll: () => Promise.resolve()
  }

  const self = {
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
    location: { origin: ORIGIN, href: `${ORIGIN}/sw.js` },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]) },
    registration: { showNotification: () => Promise.resolve() }
  }
  const caches = {
    open: () => Promise.resolve(store),
    match: (request: FakeRequest | string) => Promise.resolve(cache.get(key(request))),
    keys: () => Promise.resolve([] as string[]),
    delete: () => Promise.resolve(true)
  }
  const fetch = (request: FakeRequest): Promise<FakeResponse> => {
    fetched.push(request.url)
    return network(request.url)
  }

  // ⚠️ `no-implied-eval` guards against evaluating *untrusted* text. This text is a file in this
  // repository, read from disk by path at the top of this module, and the alternative — importing
  // it — needs `allowJs` for one classic script and forces the fakes into `globalThis`, where a
  // leak outlives the suite. Typed through `SwScript` so the call itself is still checked.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const script = new Function('self', 'caches', 'fetch', SOURCE) as unknown as SwScript
  script(self, caches, fetch)
  const fetchHandler = handlers.get('fetch')
  if (!fetchHandler) throw new Error('sw.js registered no fetch handler')
  return { fetchHandler, cache, fetched, setNetwork: (impl) => { network = impl } }
}

describe('the phone’s service worker, on a slow tailnet path', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Ask the worker for one request; `null` means it declined to intercept. */
  const ask = (env: ReturnType<typeof load>, url: string, mode = 'navigate'): Promise<FakeResponse> | null => {
    const answered: Array<Promise<FakeResponse>> = []
    env.fetchHandler({
      request: { url, method: 'GET', mode },
      respondWith: (value) => answered.push(value),
      waitUntil: () => {}
    })
    return answered[0] ?? null
  }

  /** A phone that has opened the app before, so its shell is on disk. */
  const returning = (): ReturnType<typeof load> => {
    const env = load()
    env.cache.set(`${ORIGIN}/`, response('cached shell'))
    env.cache.set(`${ORIGIN}/index.html`, response('cached shell'))
    return env
  }

  it('⛔ answers a hung navigation from the cache instead of spinning', async () => {
    vi.useFakeTimers()
    const env = returning()
    env.setNetwork(() => new Promise<FakeResponse>(() => {})) // the relay never answers
    const answered = ask(env, `${ORIGIN}/`)
    await vi.advanceTimersByTimeAsync(DEADLINE_MS)
    expect((await answered!).body).toBe('cached shell')
  })

  it('⛔ answers a failed navigation from the cache, without waiting out the deadline', async () => {
    // ⚠️ The half that reached `respondWith` as a *rejection*, which is the browser's network-error
    // page rather than a spinner. Recovering from it must not need the timer at all.
    const env = returning()
    env.setNetwork(() => Promise.reject(new Error('network unreachable')))
    expect((await ask(env, `${ORIGIN}/`)!).body).toBe('cached shell')
  })

  it('still prefers the network when it answers in time, so a new build lands', async () => {
    // ⛔ Why the navigation is network-first at all. A deadline that always won would pin an
    // installed phone to whatever bundle it happened to cache first.
    const env = returning()
    env.setNetwork(() => Promise.resolve(response('new build')))
    expect((await ask(env, `${ORIGIN}/`)!).body).toBe('new build')
    expect(env.cache.get(`${ORIGIN}/`)?.body).toBe('new build')
  })

  it('⚠️ prefers the cached shell over an error page from a daemon mid-restart', async () => {
    const env = returning()
    env.setNetwork(() => Promise.resolve(response('502 Bad Gateway', false)))
    expect((await ask(env, `${ORIGIN}/`)!).body).toBe('cached shell')
    // ⛔ And it is not written to the cache, or the next open serves the error offline too.
    expect(env.cache.get(`${ORIGIN}/`)?.body).toBe('cached shell')
  })

  it('falls back to the shell for a deep link, which was never precached under its own path', async () => {
    // The server answers `index.html` for anything it cannot find on disk; the cache has to agree.
    const env = returning()
    env.setNetwork(() => Promise.reject(new Error('network unreachable')))
    expect((await ask(env, `${ORIGIN}/task/abc`)!).body).toBe('cached shell')
  })

  it('⛔ still waits for the network on a first visit, having nothing to fall back to', async () => {
    const env = load()
    env.setNetwork(() => Promise.resolve(response('first load')))
    expect((await ask(env, `${ORIGIN}/`)!).body).toBe('first load')
  })

  it('serves the fingerprinted bundle from cache without touching the network', async () => {
    // ⚠️ Half the claim about why the fault was a round trip and not a download: the 224KB asset
    // was never on the network path to begin with.
    const env = load()
    env.cache.set(`${ORIGIN}/assets/index-abc123.js`, response('bundle'))
    expect((await ask(env, `${ORIGIN}/assets/index-abc123.js`, 'no-cors')!).body).toBe('bundle')
    expect(env.fetched).toEqual([])
  })

  it('⛔ never intercepts the API, which carries the pairing credential', () => {
    expect(ask(load(), `${ORIGIN}/remote/task.list`, 'cors')).toBeNull()
  })

  it('holds the deadline these tests are written against', () => {
    // ⚠️ The constant is duplicated here on purpose; this is what stops the copy drifting.
    expect(SOURCE).toContain(`const NAVIGATION_TIMEOUT_MS = ${DEADLINE_MS}`)
  })
})
