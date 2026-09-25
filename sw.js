const CACHE_PREFIX = 'primetime-client-';
const CACHE = `${CACHE_PREFIX}v7`;
const CACHE_READY = './.precache-ready-v7';

const CORE_ASSETS = [
  './',
  './index.html',
  './catalog-router.js?v=6',
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
  './site-update.js?v=7',
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
  './my-bookings.js?v=4',
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
    try {
      const cache = await caches.open(CACHE);
      await cache.addAll(CORE_ASSETS.map(asset => new Request(asset, { cache:'reload' })));
      await cache.put(CACHE_READY, new Response('ready'));
    } catch {
      // Do not discard the last complete offline cache on an incomplete update.
      try { await caches.delete(CACHE); } catch { /* CacheStorage may be unavailable. */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const complete = Boolean(await matchSafely(CACHE_READY));
    if (complete) {
      try {
        const keys = await caches.keys();
        await Promise.all(keys
          .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE)
          .map(key => caches.delete(key)));
      } catch { /* Navigation can continue without CacheStorage. */ }
    }
    await self.clients.claim();
    const windows = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });
    await Promise.allSettled(windows.map(client => {
      const url = new URL(client.url);
      const isPlainRoot = url.origin === self.location.origin
        && ['/', '/index.html'].includes(url.pathname)
        && !url.search;
      return isPlainRoot
        ? client.navigate(new URL('./', self.location.origin).href)
        : Promise.resolve();
    }));
    if (complete) {
      try {
        const cache = await caches.open(CACHE);
        await Promise.allSettled(OPTIONAL_ASSETS.map(asset => cache.add(asset)));
      } catch { /* Optional resources can load from the network. */ }
    }
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
  try {
    const response = await fetch(request);
    await putSafely(request, response);
    return response;
  } catch {
    return (await matchSafely(request, { ignoreSearch:true }))
      || (await matchSafely('./offline.html'))
      || new Response('<!doctype html><html lang="ru"><meta charset="utf-8"><title>Нет связи</title><p>Сейчас нет связи. Повторите попытку позже.</p></html>', {
        status: 503,
        headers: { 'Content-Type':'text/html; charset=utf-8' }
      });
  }
}

async function cacheFirstAsset(request) {
  const cached = await matchSafely(request);
  if (cached) return cached;
  const response = await fetch(request);
  await putSafely(request, response);
  return response;
}

async function matchSafely(request, options) {
  try { return await caches.match(request, options); } catch { return undefined; }
}

async function putSafely(request, response) {
  if (!response.ok) return;
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  } catch { /* A cache write must not discard a usable network response. */ }
}
