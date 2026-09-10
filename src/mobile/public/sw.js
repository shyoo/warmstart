/* Service worker: installability, an offline shell, and the notification half of Web Push.
 *
 * It caches the app shell (HTML, JS, CSS, manifest, icons) and passes every other request
 * through untouched — `/remote/*` must never be cached, and POSTs never are.
 */
const SHELL = './sw-shell-v2'

/**
 * How long a navigation waits for the network before the cached shell answers instead.
 *
 * ⛔ **Because the phone is reached over a tailnet relay, not a LAN.** Off the home network
 * Tailscale routinely cannot build a direct connection and falls back to a DERP relay: measured
 * 2026-09-09 from `shyoo-12700k` to a phone off the LAN, `tailscale ping` reported *"direct
 * connection not established"* and 324ms–1.0s per round trip, against 19.7ms to the machine's
 * own nearest relay. That is slow but perfectly usable — the app shell is already on the phone,
 * and everything the screens then read is small JSON.
 *
 * ⚠️ The number is a deadline, not a budget. Whatever the network eventually answers still
 * populates the cache for the next open, so a phone that took the cached shell today is not
 * pinned to it tomorrow.
 */
const NAVIGATION_TIMEOUT_MS = 2500

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL)
      await cache.addAll(['./', './index.html', './manifest.webmanifest', './favicon.svg', './icon-1024.png'])
      await self.skipWaiting()
    })()
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))
      await self.clients.claim()
    })()
  )
})

/**
 * Fetch, and keep a good same-origin answer for next time.
 *
 * ⚠️ The cache write never delays the reply, but it is handed to `waitUntil` rather than left to
 * run loose: a worker may be shut down the moment it has answered, and a refresh that is racing
 * that shutdown is the one that most needs to finish.
 */
async function fetchAndCache(event, url) {
  const live = await fetch(event.request)
  if (live.ok && url.origin === self.location.origin) {
    const copy = live.clone()
    event.waitUntil(caches.open(SHELL).then((cache) => cache.put(event.request, copy)))
  }
  return live
}

/**
 * The network's answer if it arrives in time, the cached one if it does not.
 *
 * ⛔ **Neither a timeout nor a rejection may reach the page.** This is the whole bug: a bare
 * `await fetch()` on the navigation path had no deadline, no `catch` and no fallback, so a slow
 * or stalled relay produced a spinner and then the browser's network-error page — with a
 * complete shell sitting unused in the cache. What it was waiting on is `index.html`, **1,170
 * bytes**; the 224KB bundle beside it is fingerprinted, is not `freshFirst`, and was already
 * being served from cache. So the app refused to open over a round trip, not over a download.
 *
 * ⚠️ A non-`ok` answer loses to the cache too. A daemon mid-restart replies 502, and rendering
 * that over a known-good shell trades a working screen for an error page.
 */
function withDeadline(live, cached, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(cached), ms)
    live.then(
      (response) => {
        clearTimeout(timer)
        resolve(response.ok ? response : cached)
      },
      () => {
        clearTimeout(timer)
        resolve(cached)
      }
    )
  })
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.pathname.startsWith('/remote/')) return
  event.respondWith(
    (async () => {
      // Navigation and the manifest must ask the server first, so an installed phone picks up
      // an updated service worker and bundle without sacrificing its local pairing credential.
      const freshFirst = event.request.mode === 'navigate' || /\/(?:index\.html|manifest\.webmanifest|sw\.js)$/.test(url.pathname)
      if (!freshFirst) {
        const cached = await caches.match(event.request)
        if (cached) return cached
        return fetchAndCache(event, url)
      }
      // ⚠️ A navigation falls back to the shell for *any* path, because the server already works
      // that way: anything it cannot find on disk it answers with `index.html`. Only `./` was
      // precached, so without this a deep link would have no fallback to prefer.
      const cached =
        (await caches.match(event.request)) ??
        (event.request.mode === 'navigate' ? await caches.match('./index.html') : undefined)
      const live = fetchAndCache(event, url)
      // ⛔ Nothing cached yet — a first visit, or one whose shell was evicted. There is no
      // fallback to prefer, so this is the one case that must still wait for the network.
      if (!cached) return live
      // ⚠️ The revalidation outlives the response, so the worker has to be told to stay alive for
      // it; and its rejection is answered here, or a failed refresh surfaces as an unhandled one.
      event.waitUntil(live.catch(() => {}))
      return withDeadline(live, cached, NAVIGATION_TIMEOUT_MS)
    })()
  )
})

/* ⛔ The payload is already decrypted by the browser and carries only a title, a sentence and a
 * task id — never a prompt, a path or a credential. See `src/daemon/remote/push.ts`. */
self.addEventListener('push', (event) => {
  let alert = { title: 'Warmstart', body: 'Something needs you.', taskId: null }
  try {
    if (event.data) alert = { ...alert, ...event.data.json() }
  } catch {
    /* A push with no readable body is still worth showing; the app knows what is waiting. */
  }
  event.waitUntil(
    self.registration.showNotification(alert.title, {
      body: alert.body,
      icon: './icon-1024.png',
      badge: './icon-1024.png',
      // Same tag, one notification: a task that keeps changing must not stack up a column of them.
      tag: alert.taskId ? `task:${alert.taskId}` : 'fleet',
      renotify: true,
      data: { taskId: alert.taskId }
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const taskId = event.notification.data && event.notification.data.taskId
  const target = taskId ? `./#/task/${encodeURIComponent(taskId)}` : './#/'
  event.waitUntil(
    (async () => {
      const url = new URL(target, self.location.href).href
      // Prefer an open window: on a phone, launching a second copy of an installed app is jarring.
      for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
        if (new URL(client.url).origin === self.location.origin && 'navigate' in client) {
          await client.navigate(url)
          return client.focus()
        }
      }
      return self.clients.openWindow(url)
    })()
  )
})
