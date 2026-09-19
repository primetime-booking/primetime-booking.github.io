(function routePrimeTimeCatalog() {
  'use strict';

  const PAGES_HOST = 'primetime-booking.github.io';
  const CATALOG_ORIGIN = 'https://primetime-booking.primetime-booking-ru.workers.dev';
  const rootPaths = new Set(['/', '/index.html']);
  const directBookingParameters = new Set(['org', 'service', 'provider', 'location', 'group']);
  const catalogPaths = [
    /^\/(?:favorites|map|bookings|nearby|result-match|multi-service)\/?$/,
    /^\/(?:r|master)\/[a-z0-9-]+\/?$/
  ];
  const attributionParameters = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'source', 'pilot'
  ]);
  const profileParameters = new Set(['service', 'slot', 'replace', 'returnTo', 'from']);

  const current = window.location;
  if (current.hostname !== PAGES_HOST) return;

  const path = current.pathname.replace(/\/{2,}/g, '/');
  const isRoot = rootPaths.has(path);
  const input = new URLSearchParams(current.search);
  if (isRoot && [...directBookingParameters].some(key => input.has(key))) return;
  if (!isRoot && !catalogPaths.some(pattern => pattern.test(path))) return;

  const destination = new URL(isRoot ? '/' : path, CATALOG_ORIGIN);
  const allowed = new Set(attributionParameters);
  if (/^\/(?:r|master)\//.test(path)) {
    profileParameters.forEach(key => allowed.add(key));
  }
  input.forEach((value, key) => {
    if (!allowed.has(key)) return;
    if (key === 'returnTo' && !/^\/[a-z0-9/_?=&.-]*$/i.test(value)) return;
    destination.searchParams.append(key, value.slice(0, 240));
  });

  current.replace(destination.href);
})();
