import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(root, 'app.js'), 'utf8');
const index = readFileSync(join(root, 'index.html'), 'utf8');
const siteUpdate = readFileSync(join(root, 'site-update.js'), 'utf8');
const serviceWorker = readFileSync(join(root, 'sw.js'), 'utf8');
const loadAvailabilitySource = app.match(/async function loadAvailability\(\) \{[\s\S]*?\n\}(?=\r?\n\r?\nfunction openWaitlistDialog)/)?.[0] || '';
assert.ok(loadAvailabilitySource, 'Не удалось извлечь загрузку свободного времени');
assert.match(app, /retryAvailability[\s\S]*void loadAvailability\(\)/, 'Повтор availability не подключён');
assert.match(index, /site-update\.js\?v=2[\s\S]*app\.js\?v=2/, 'Клиентская страница не ссылается на новый availability-пакет');
assert.match(siteUpdate, /sw\.js\?v=2/, 'Update-check не запрашивает новый service worker');
assert.match(serviceWorker, /CACHE_PREFIX\}v2/, 'Версия PWA-кэша не обновлена');
assert.match(serviceWorker, /app\.js\?v=2/, 'Новый app.js не добавлен в PWA-кэш');

const dates = [
  { iso:'2099-09-07', label:'7 сентября', weekday:'пн', day:7 },
  { iso:'2099-09-08', label:'8 сентября', weekday:'вт', day:8 }
];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function createHarness(loadPublicSlots, timeoutMs = 20) {
  const service = { id:'service-a' };
  const state = {
    serviceId:service.id,
    locationId:'location-a',
    availability:new Map(),
    availabilityServiceId:'',
    availabilityLocationId:'',
    availabilityError:false,
    loadingAvailability:false,
    time:'',
    hour:'',
    period:'all'
  };
  const noTimes = { hidden:true, innerHTML:'', textContent:'' };
  const statuses = [];
  let renderCount = 0;
  const factory = Function(
    'state', 'dates', 'selectedService', 'loadPublicSlots', 'renderDates', 'renderTimes', '$', 'setBookingStatus', 'navigator', 'AVAILABILITY_REQUEST_TIMEOUT_MS',
    `let availabilityLoadRevision = 0;
     ${loadAvailabilitySource}
     return { loadAvailability, supersede(){ availabilityLoadRevision += 1; } };`
  );
  const controller = factory(
    state,
    dates,
    () => state.serviceId === service.id ? service : null,
    loadPublicSlots,
    () => { renderCount += 1; },
    () => { renderCount += 1; },
    selector => selector === '#noTimes' ? noTimes : null,
    (kind, text) => statuses.push({ kind, text }),
    { onLine:true },
    timeoutMs
  );
  return { ...controller, state, noTimes, statuses, renderCount:() => renderCount };
}

{
  let aborted = false;
  const harness = createHarness((_service, _start, _end, _location, signal) => {
    signal?.addEventListener('abort', () => { aborted = true; }, { once:true });
    return new Promise(() => {});
  });
  await harness.loadAvailability();
  assert.equal(aborted, true, 'Timeout must abort a supported availability request');
  assert.equal(harness.state.loadingAvailability, false, 'Hung request must leave loading');
  assert.equal(harness.state.availabilityError, true, 'Hung request must become an error');
  assert.match(harness.noTimes.innerHTML, /дольше обычного[\s\S]*retryAvailability/, 'Timeout needs a clear retry action');
}

{
  const harness = createHarness(async () => { throw new Error('transport_failed'); });
  await harness.loadAvailability();
  assert.equal(harness.state.loadingAvailability, false, 'Rejected transport must leave loading');
  assert.equal(harness.state.availabilityError, true, 'Rejected transport must become an error');
  assert.match(harness.noTimes.innerHTML, /Не удалось загрузить расписание[\s\S]*Повторить/, 'Transport error needs retry copy');
}

{
  const requests = [deferred(), deferred()];
  let requestIndex = 0;
  const harness = createHarness(() => requests[requestIndex++].promise, 200);
  const stale = harness.loadAvailability();
  const current = harness.loadAvailability();
  requests[0].resolve({ data:[{ booking_date:dates[0].iso, booking_time:'10:00:00' }], error:null });
  await stale;
  assert.equal(harness.state.loadingAvailability, true, 'Stale completion must not clear the current loader');
  requests[1].resolve({ data:[], error:null });
  await current;
  assert.equal(harness.state.loadingAvailability, false, 'Current completion must clear loading');
  assert.equal(harness.state.availabilityError, false);
}

{
  const harness = createHarness(async () => ({ data:[], error:null }));
  await harness.loadAvailability();
  assert.equal(harness.state.loadingAvailability, false, 'Empty success must leave loading');
  assert.equal(harness.state.availabilityError, false, 'Empty success is not an error');
  assert.deepEqual([...harness.state.availability.keys()], dates.map(item => item.iso), 'Empty success must mark every requested date as loaded');
  assert.match(harness.noTimes.textContent, /свободного времени нет/);
}

{
  let attempt = 0;
  const harness = createHarness(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('temporary_failure');
    return { data:[{ booking_date:dates[1].iso, booking_time:'12:30:00' }], error:null };
  });
  await harness.loadAvailability();
  assert.equal(harness.state.availabilityError, true);
  await harness.loadAvailability();
  assert.equal(attempt, 2, 'Retry must issue a fresh availability request');
  assert.equal(harness.state.loadingAvailability, false);
  assert.equal(harness.state.availabilityError, false, 'Successful retry must recover the state');
  assert.deepEqual(harness.state.availability.get(dates[1].iso), ['12:30']);
  assert.deepEqual(harness.statuses.at(-1), { kind:'open', text:'Запись открыта' });
}

console.log('availability loading recovery test: OK');
