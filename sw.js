// Service worker: ưu tiên mạng (luôn lấy bản mới nhất sau mỗi lần deploy),
// chỉ dùng bản đã lưu khi mất mạng. Đường dẫn tính theo vị trí của chính file này,
// nên chạy được cả ở gốc tên miền lẫn trong thư mục con.

const CACHE = 'so-ghi-am-v2';
const BASE = new URL('./', self.location).href;
const SHELL = [
  './',
  'css/styles.css',
  'js/format.js',
  'js/storage.js',
  'js/wav.js',
  'js/app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
].map(p => new URL(p, BASE).href);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true })
          .then(hit => hit || (req.mode === 'navigate' ? caches.match(BASE) : Response.error()))
      )
  );
});
