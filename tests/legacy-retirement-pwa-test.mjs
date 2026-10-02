import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const origin = 'https://primetime-booking.github.io';
const worker = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const router = readFileSync(new URL('../catalog-router.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const key = (request) => new URL(request?.url || request, origin + '/').href;
class WorkerRequest extends Request {
  constructor(input, options) { super(key(input), options); }
}
for (const previous of [7, 8]) {
  const buckets = new Map([
    [`primetime-client-v${previous}`, new Map([[key('./index.html'), new Response('OLD FORM')],
      [key('./catalog-router.js?v=7'), new Response('OLD ROUTER')]])],
    ['foreign-cache', new Map([[key('./history'), new Response('PRESERVED')]])],
  ]);
  const caches = {
    async open(name) {
      if (!buckets.has(name)) buckets.set(name, new Map());
      const data = buckets.get(name);
      return {
        async addAll(requests) { for (const request of requests) data.set(key(request), await fetchAsset(request)); },
        async add(request) { data.set(key(request), await fetchAsset(request)); },
        async put(request, response) { data.set(key(request), response.clone()); },
      };
    },
    async keys() { return [...buckets.keys()]; },
    async delete(name) { return buckets.delete(name); },
    async match(request, options = {}) {
      for (const data of buckets.values()) {
        const wanted = key(request);
        for (const [stored, response] of data) {
          if (stored === wanted || (options.ignoreSearch &&
            new URL(stored).pathname === new URL(wanted).pathname)) return response.clone();
        }
      }
      return undefined;
    },
  };
  let online = true;
  async function fetchAsset(request) {
    if (!online) throw Error('offline');
    const path = new URL(key(request));
    if (path.pathname === '/' || path.pathname === '/index.html') return new Response(index);
    if (path.pathname === '/catalog-router.js') {
      assert.equal(path.search, '?v=8', 'the new shell asks for a fresh router cache key');
      return new Response(router);
    }
    return new Response('STATIC ASSET');
  }
  const events = {}, navigated = [];
  const self = {
    location: { origin }, addEventListener(type, callback) { events[type] = callback; },
    async skipWaiting() {}, clients: {
      async claim() {},
      async matchAll() { return [
        { url: origin + '/', async navigate(url) { navigated.push(url); } },
        { url: origin + '/?org=minuta-example', async navigate() { throw Error('Active direct form was forced away'); } },
        { url: origin + '/booking.html?token=historical', async navigate() { throw Error('Historical management lost'); } },
      ]; },
    },
  };
  const context = { self, caches, fetch: fetchAsset, Request: WorkerRequest, Response, URL, Promise };
  runInNewContext(worker, context);
  for (const event of ['install', 'activate']) {
    let pending;
    events[event]({ waitUntil(work) { pending = work; } });
    await pending;
  }
  assert.equal(buckets.has(`primetime-client-v${previous}`), false);
  assert.equal(buckets.has('primetime-client-v9'), true);
  assert.equal(buckets.has('foreign-cache'), true);
  assert.deepEqual(navigated, [origin + '/']);
  online = false;
  context.request = new WorkerRequest('/?org=minuta-abeb5b13ca1d45c6a2adb0e4119b2e1f');
  const shell = await runInNewContext('networkFirstNavigation(request)', context);
  assert.match(await shell.text(), /catalog-router\.js\?v=8/);
  context.request = new WorkerRequest('/catalog-router.js?v=8');
  const actualRouter = await (await runInNewContext('cacheFirstAsset(request)', context)).text();
  let destination;
  runInNewContext(actualRouter, { URL, URLSearchParams, window: { location: {
    hostname: 'primetime-booking.github.io', pathname: '/',
    search: '?org=minuta-abeb5b13ca1d45c6a2adb0e4119b2e1f', hash: '',
    replace(value) { destination = value; },
  } } });
  assert.equal(destination, 'https://primetime-booking.primetime-booking-ru.workers.dev/legacy-booking?org=minuta-abeb5b13ca1d45c6a2adb0e4119b2e1f');
}
console.log('legacy PWA v7/v8 -> v9: PASS; fresh router, preserved historical paths');
