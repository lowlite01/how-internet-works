/* Service worker: учебник открывается и без интернета.
   Стратегия «сначала сеть»: если сеть есть — берём свежий файл и обновляем кэш,
   если нет — отдаём сохранённую копию. Так обновления на сайте видны сразу. */
const CACHE = 'how-internet-works-v7';
const FILES = [
  './', './index.html', './style.css', './data.js', './app.js', './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(
    // cache: 'no-cache' — всегда сверяться с сервером, а не брать старую копию из HTTP-кэша браузера
    fetch(req, { cache: 'no-cache' })
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(cache => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('./index.html'))));
});
