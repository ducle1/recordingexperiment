// Bản web cũ (Sổ Ghi Âm) có cài service worker. File này gỡ nó ra và xoá bộ nhớ đệm cũ
// để mọi người luôn nhận phiên bản mới nhất.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach((c) => c.navigate(c.url));
  })());
});
