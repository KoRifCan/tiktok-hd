/* Cache the ffmpeg engine so repeat visits do not download it again.
 * HTML and application code stay network-first; only /ffmpeg/* is cached. */
var CACHE = 'korifcan-ffmpeg-v1';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    var keys = await caches.keys();
    await Promise.all(keys.filter(function (key) {
      return key.indexOf('korifcan-ffmpeg-') === 0 && key !== CACHE;
    }).map(function (key) {
      return caches.delete(key);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/ffmpeg/') === -1) return;

  event.respondWith((async function () {
    var cache = await caches.open(CACHE);
    var hit = await cache.match(request);
    if (hit) return hit;
    var response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  })());
});
