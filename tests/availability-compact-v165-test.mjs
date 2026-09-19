import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase-migration-v165.sql', import.meta.url), 'utf8');
const rollback = readFileSync(new URL('../supabase-migration-v165-rollback.sql', import.meta.url), 'utf8');

assert.match(migration, /get_available_slots_compact_v165[\s\S]*array_agg\(slot\.booking_time order by slot\.booking_time\)[\s\S]*from public\.get_available_slots_v101[\s\S]*group by slot\.booking_date/i);
assert.match(migration, /get_public_minuta_available_slots_compact_v165[\s\S]*array_agg\(slot\.booking_time order by slot\.booking_time\)[\s\S]*from public\.get_public_minuta_available_slots_v101[\s\S]*group by slot\.booking_date/i);
assert.match(migration, /grant execute on function public\.get_available_slots_compact_v165[\s\S]*to anon,authenticated/i);
assert.match(migration, /grant execute on function public\.get_public_minuta_available_slots_compact_v165[\s\S]*to anon,authenticated/i);
assert.match(rollback, /drop function if exists public\.get_public_minuta_available_slots_compact_v165/);
assert.match(rollback, /drop function if exists public\.get_available_slots_compact_v165/);

const source = app.match(/function expandCompactAvailabilityRows\(rows\) \{[\s\S]*?\n\}(?:\r?\n){2}function availabilityRpc[\s\S]*?\n\}(?:\r?\n){2}async function loadPublicSlots[\s\S]*?\n\}(?=\r?\n\r?\nfunction renderLocations)/)?.[0] || '';
assert.ok(source, 'Compact availability client adapter was not found');

function createHarness({ resourceScheduling = false, replies = {} } = {}) {
  const calls = [];
  const db = {
    rpc:(name, parameters) => {
      calls.push({ name, parameters });
      const reply = replies[name];
      if (typeof reply === 'function') return Promise.resolve(reply(parameters));
      return Promise.resolve(reply || { data:[], error:null });
    }
  };
  const state = { resourceScheduling, groupBookingSafety:true, branchShiftScheduling:true, locationId:'location-a' };
  const isMissingRpc = (error, name) => Boolean(error && error.code === 'PGRST202' && String(error.message || '').includes(name));
  const api = Function('db', 'state', 'requestedOrganizationSlug', 'isMissingRpc', `${source}; return { expandCompactAvailabilityRows, loadPublicSlots };`)(db, state, 'org-a', isMissingRpc);
  return { ...api, calls, state };
}

const dates = Array.from({ length:14 }, (_, index) => `2099-09-${String(index + 1).padStart(2, '0')}`);
const times = Array.from({ length:120 }, (_, index) => `${String(Math.floor(index / 12)).padStart(2, '0')}:${String((index % 12) * 5).padStart(2, '0')}:00`);
const compactRows = dates.map(booking_date => ({ booking_date, booking_times:times }));
const legacyRows = compactRows.flatMap(item => item.booking_times.map(booking_time => ({ booking_date:item.booking_date, booking_time })));
assert.ok(JSON.stringify(compactRows).length < JSON.stringify(legacyRows).length / 2, 'Compact transport must remove repeated per-slot date/key overhead');

{
  const harness = createHarness({ replies:{ get_available_slots_compact_v165:{ data:compactRows, error:null } } });
  const result = await harness.loadPublicSlots({ id:'service-a' }, dates[0], dates.at(-1));
  assert.equal(harness.calls.length, 1, 'Compact personal availability must avoid the legacy thousand-row request');
  assert.equal(harness.calls[0].name, 'get_available_slots_compact_v165');
  assert.equal(result.data.length, 1680, 'All slots must survive compact transport, including payloads above 1000 slots');
  assert.deepEqual(result.data.at(-1), { booking_date:dates.at(-1), booking_time:times.at(-1) }, 'Far dates must not be truncated');
}

{
  const missing = { data:null, error:{ code:'PGRST202', message:'get_available_slots_compact_v165 was not found' } };
  const legacy = [{ booking_date:dates[0], booking_time:'10:00:00' }];
  const harness = createHarness({ replies:{
    get_available_slots_compact_v165:missing,
    get_available_slots_v101:{ data:legacy, error:null }
  } });
  const result = await harness.loadPublicSlots({ id:'service-a' }, dates[0], dates.at(-1));
  assert.deepEqual(harness.calls.map(call => call.name), ['get_available_slots_compact_v165', 'get_available_slots_v101']);
  assert.deepEqual(result.data, legacy, 'Pre-v165 deployments must keep the authoritative v101 fallback');
}

{
  const harness = createHarness({ resourceScheduling:true, replies:{
    get_public_minuta_available_slots_compact_v165:{ data:compactRows, error:null }
  } });
  const result = await harness.loadPublicSlots({ id:'service-a' }, dates[0], dates.at(-1), 'location-a');
  assert.equal(harness.calls.length, 1, 'Compact team availability must avoid legacy fallback when v165 exists');
  assert.equal(harness.calls[0].name, 'get_public_minuta_available_slots_compact_v165');
  assert.deepEqual(harness.calls[0].parameters, {
    p_slug:'org-a', p_location:'location-a', p_service:'service-a', p_start:dates[0], p_end:dates.at(-1)
  });
  assert.equal(result.data.length, 1680);
}

{
  const harness = createHarness({ replies:{
    get_available_slots_compact_v165:{ data:null, error:{ code:'42501', message:'denied' } }
  } });
  const result = await harness.loadPublicSlots({ id:'service-a' }, dates[0], dates.at(-1));
  assert.equal(harness.calls.length, 1, 'Real compact RPC errors must not be hidden by a legacy fallback');
  assert.equal(result.error.code, '42501');
}

console.log('availability compact v165 test: OK');
