// 更新を配るときは CACHE_VERSION を上げる
const CACHE_VERSION = 'mj-v8';
const FILES = [
  './', './index.html', './logic.js', './manifest.json', './icon-192.png', './icon-512.png',
  './online.html', './online.js', './online.css', './sync.js', './room.js', './mqtt.js',
  './lib/qrcode.js', './lib/jsQR.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// キャッシュがあればすぐ返し、裏で最新を取り直す（次に開いたとき更新が反映される）
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    caches.open(CACHE_VERSION).then((cache) =>
      cache.match(e.request).then((hit) => {
        const fetched = fetch(e.request)
          .then((res) => { if (res && res.ok) cache.put(e.request, res.clone()); return res; })
          .catch(() => hit || cache.match('./index.html'));
        return hit || fetched;
      })
    )
  );
});
