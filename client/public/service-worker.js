// Cache name is bumped on deploys that must invalidate the cached shell.
// (v1 was cache-first for /index.html, which pinned the old JS bundle forever.)
const CACHE = 'mjlemon-shell-v2';
const SHELL = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/report/')) return;
  if (e.request.method !== 'GET') return;

  // HTML shell: network-FIRST. The index.html references hash-named JS/CSS, so
  // serving a stale cached shell pins the old bundle and strands every deploy.
  // Always try the network and only fall back to cache when offline.
  const isShell = e.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html';
  if (isShell) {
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('/index.html').then((hit) => hit || caches.match('/')))
    );
    return;
  }

  // Hashed static assets are immutable per build → cache-first is safe and fast.
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match('/index.html')))
  );
});
