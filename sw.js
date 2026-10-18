// Service worker: caches the whole app shell so it opens and plays with no network.
// Songs themselves live in IndexedDB (saved on the device when you add them).
const CACHE = 'melody-motion-v2';
const SHELL = ['./', 'index.html', 'app.js', 'scene.js', 'notes.js', 'analysis.js', 'worker.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const net = fetch(req).then((res) => { if (res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())); return res; }).catch(() => hit);
      return hit || net; // cache-first, refreshed in the background
    })
  );
});
