// Waxingmachine9000 – offline-tuki. Välimuistissa on vain sovelluksen omat tiedostot;
// data (CSV:t) on selaimen IndexedDB:ssä eikä kulje tämän kautta.
// Kasvata versiota, kun tiedostolista muuttuu.
const CACHE = 'wax9000-v3';
const ASSETS = [
  './',
  'index.html',
  'src/core.js',
  'src/ui.js',
  'src/style.css',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-512.png',
];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Verkko ensin, jotta päivitykset tulevat perille; heikolla tai puuttuvalla yhteydellä välimuisti.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([
        fetch(req),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS)),
      ]);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      return (await cache.match(req, { ignoreSearch: true })) || (await cache.match('index.html')) || Response.error();
    }
  })());
});
