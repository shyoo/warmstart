/* Service worker: installability, an offline shell, and the notification half of Web Push.
 *
 * It caches the app shell (HTML, JS, CSS, manifest, icons) and passes every other request
 * through untouched — `/remote/*` must never be cached, and POSTs never are.
 */
const SHELL = './sw-shell-v2'

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
      }
      const live = await fetch(event.request)
      if (live.ok && url.origin === self.location.origin) {
        const cache = await caches.open(SHELL)
        void cache.put(event.request, live.clone())
      }
      return live
    })()
  )
})

/* ⛔ The payload is already decrypted by the browser and carries only a title, a sentence and a
 * task id — never a prompt, a path or a credential. See `src/daemon/remote/push.ts`. */
self.addEventListener('push', (event) => {
  let alert = { title: 'Multi Agent Controller', body: 'Something needs you.', taskId: null }
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
