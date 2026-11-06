const CACHE_NAME = 'driving-log-v10';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.png',
  './schools.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Sheet refreshes must reach the network and fail visibly when offline.
  // Never serve cached API responses in place of an edited spreadsheet.
  const url = new URL(event.request.url);
  if (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com') {
    event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});
