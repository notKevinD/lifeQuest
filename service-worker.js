const CACHE_NAME = 'questlife-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/manifest.json'
];

// Install Service Worker & Cache dasar
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// Jalankan Fetch & serve dari cache jika offline (opsional)
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});