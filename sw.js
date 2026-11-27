// 更新を配るときは CACHE_VERSION を上げる
const CACHE_VERSION = 'mj-v12';
const FILES = [
  './', './index.html', './app.js', './app.css', './ui.js', './logic.js', './sync.js', './room.js', './mqtt.js',
  './online.html', './online.js', './manifest.json', './icon-192.png', './icon-512.png',
  './lib/qrcode.js', './lib/jsQR.js'
];

self.addEventListener('install', (e) => {
  // ブラウザのHTTPキャッシュに残った古いファイルを拾わないよう、取り直してから入れる
  e.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
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
      cache.match(e.request, { ignoreSearch: true }).then((hit) => {
        const fetched = fetch(e.request)
          .then((res) => { if (res && res.ok) cache.put(e.request, res.clone()); return res; })
          .catch(() => hit || cache.match('./index.html'));
        return hit || fetched;
      })
    )
  );
});
