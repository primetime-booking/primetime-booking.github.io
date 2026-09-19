const CACHE_PREFIX = 'primetime-client-';
const CACHE = `${CACHE_PREFIX}v3`;

const CORE_ASSETS = [
  './',
  './index.html',
  './offline.html',
  './offline.js',
  './manifest.webmanifest',
  './icon.svg',
  './ui-icons.svg',
  './styles.css?v=811',
  './client-themes.css?v=811',
  './code-scanner.css?v=811',
  './vendor/supabase-2.112.4.min.js',
  './config.js?v=811',
  './theme-catalog.js?v=811',
  './site-update.js?v=3',
  './reliability.js?v=811',
  './group-bookings.js?v=811',
  './booking-widgets.js?v=811',
  './telegram-auth.js?v=811',
  './code-scanner.js?v=811',
  './app.js?v=3'
];

const OPTIONAL_ASSETS = [
  './booking.html',
  './booking.js?v=811',
  './my-bookings.html',
  './my-bookings.js?v=811',
  './waitlist.html',
  './waitlist.js?v=811',
  './messages.html',
  './messages-center.css?v=811',
  './messages-core.js?v=811',
  './provider-messages-center.js?v=811',
  './client-messages.js?v=811',
  './phone-auth.js?v=811',
  './social-auth.js?v=811',
  './privacy.html',
  './privacy.js?v=811',
  './terms.html',
  './legal-ux.css?v=811',
  './404.html',
  './og.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      await cache.addAll(CORE_ASSETS.map(asset => new Request(asset, { cache:'reload' })));
      await self.skipWaiting();
    } catch (error) {
      await caches.delete(CACHE);
      throw error;
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE)
      .map(key => caches.delete(key)));
    await self.clients.claim();
    const cache = await caches.open(CACHE);
    await Promise.allSettled(OPTIONAL_ASSETS.map(asset => cache.add(asset)));
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event.request));
    return;
  }
  event.respondWith(cacheFirstAsset(event.request));
});

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request, { ignoreSearch:true }))
      || (await cache.match('./offline.html'));
  }
}

async function cacheFirstAsset(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}
