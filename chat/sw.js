/* Crew Chat service worker — stale-while-revalidate app shell.
 *
 * Only registers in a secure context (localhost, or the hub behind HTTPS).
 * Over plain http://<lan-ip> browsers refuse service workers, which is fine:
 * the app still runs, it just needs the hub reachable to load the page.
 * Message history lives in IndexedDB either way. */

const CACHE = 'crewchat-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './chat-192.png', './chat-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  /* Never cache the live surfaces: presence, uploads and the roster must be
     whatever the hub says right now. Uploaded files are immutable, so they
     are safe to keep. */
  if (url.pathname === '/info' || url.pathname === '/health') return;

  if (url.pathname.startsWith('/files/')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }))
    );
    return;
  }

  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const live = fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => hit || caches.match('./index.html'));
      return hit || live;
    })
  );
});
