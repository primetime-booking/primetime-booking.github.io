import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');

function createWorker(caches, fetch) {
  const handlers = {};
  const state = { claimed: false, skipped: false };
  const self = {
    location: { origin: 'https://primetime-booking.github.io' },
    addEventListener(type, callback) { handlers[type] = callback; },
    async skipWaiting() { state.skipped = true; },
    clients: {
      async claim() { state.claimed = true; },
      async matchAll() { return []; },
    },
  };
  const context = { self, caches, fetch, Request, Response, URL, Promise };
  runInNewContext(source, context);
  return { context, handlers, state };
}

async function lifecycle(handler) {
  let work = Promise.resolve();
  handler({ waitUntil(promise) { work = Promise.resolve(promise); } });
  await work;
}

const unavailable = new Error('CacheStorage unavailable');
const brokenCache = {
  async open() { throw unavailable; },
  async match() { throw unavailable; },
  async keys() { throw unavailable; },
  async delete() { throw unavailable; },
};
const online = createWorker(brokenCache, async () => new Response('NETWORK'));
await lifecycle(online.handlers.install);
await lifecycle(online.handlers.activate);
assert.equal(online.state.skipped, true);
assert.equal(online.state.claimed, true);
online.context.request = new Request('https://primetime-booking.github.io/');
assert.equal(await (await runInNewContext('networkFirstNavigation(request)', online.context)).text(), 'NETWORK');
assert.equal(await (await runInNewContext('cacheFirstAsset(request)', online.context)).text(), 'NETWORK');

const deleted = [];
const incomplete = createWorker({
  async open() { return { async addAll() { throw new Error('precache failed'); } }; },
  async delete(name) { deleted.push(name); return true; },
  async keys() { return ['primetime-client-v6']; },
  async match(request) {
    if (request === './offline.html') return new Response('OLD OFFLINE');
    return undefined;
  },
}, async () => { throw new Error('offline'); });
await lifecycle(incomplete.handlers.install);
await lifecycle(incomplete.handlers.activate);
assert.equal(incomplete.state.skipped, true);
assert.equal(incomplete.state.claimed, true);
assert.deepEqual(deleted, ['primetime-client-v7']);
incomplete.context.request = new Request('https://primetime-booking.github.io/');
assert.equal(await (await runInNewContext('networkFirstNavigation(request)', incomplete.context)).text(), 'OLD OFFLINE');

console.log('Pages SW cache failures: PASS');
