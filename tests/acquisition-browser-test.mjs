import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PRIMETIME_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PRIMETIME_PLAYWRIGHT_MODULE).href : 'playwright');
const ids = {
  org:'11111111-1111-4111-8111-111111111111',
  service:'22222222-2222-4222-8222-222222222222',
  performer:'33333333-3333-4333-8333-333333333333',
  branch:'44444444-4444-4444-8444-444444444444'
};
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const catalog = {
  organization:{ id:ids.org, name:'Студия PrimeTime' }, resource_scheduling:false, branch_shift_scheduling:false,
  client_page:{ theme_key:'sage', headline_key:'massage-time' },
  locations:[{ id:ids.branch, name:'Центр', is_primary:true }],
  services:[{ id:ids.service, performer_id:ids.performer, name:'Массаж', duration_minutes:60, price_rub:1500, location_ids:[ids.branch], performer_profiles:{ display_name:'Анна' } }]
};
const calls = [];
const unexpected = [];
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.woff2':'font/woff2', '.webmanifest':'application/manifest+json' };
let origin = '';

function json(response, value, status = 200) {
  response.writeHead(status, { 'content-type':'application/json', 'cache-control':'no-store' });
  response.end(JSON.stringify(value));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin);
    if (url.pathname === '/auth/v1/settings') return json(response, { external:{ phone:false } });
    if (request.method === 'POST' && url.pathname.startsWith('/rest/v1/rpc/')) {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const name = url.pathname.split('/').at(-1);
      const args = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      calls.push({ name, args });
      if (['get_public_minuta_catalog_v5','get_public_minuta_catalog_v4'].includes(name)) return json(response, catalog);
      if (['get_public_minuta_available_slots_compact_v165','get_available_slots_compact_v165'].includes(name)) {
        return json(response, { code:'PGRST202', message:`Could not find the function public.${name}` }, 404);
      }
      if (['get_public_minuta_available_slots_v101','get_available_slots_v101','get_available_slots'].includes(name)) return json(response, [{ booking_date:tomorrow, booking_time:'10:00:00' }]);
      if (name === 'get_public_minuta_group_events') return json(response, { enabled:false, events:[] });
      if (['track_public_booking_funnel_event','upsert_public_booking_presence'].includes(name)) return json(response, true);
      if (name === 'get_public_booking_reviews' || name === 'get_public_service_cards_v159') return json(response, []);
      unexpected.push(`RPC ${name}`);
      return json(response, { code:'PGRST202', message:`function ${name} does not exist` }, 404);
    }
    if (request.method !== 'GET') throw new Error(`Unexpected method ${request.method}`);
    const relative = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
    if (relative.includes('\\') || relative.split('/').includes('..')) throw new Error('Disallowed URL');
    const target = resolve(root, relative);
    if (!target.startsWith(root + sep)) throw new Error('Path escapes fixture root');
    if (relative === 'config.js') {
      response.writeHead(200, { 'content-type':'text/javascript' });
      return response.end(`window.MINUTA_CONFIG=${JSON.stringify({ supabaseUrl:origin, supabaseKey:'fixture-anon-key', defaultOrganizationSlug:'' })};`);
    }
    if (relative.startsWith('vendor/supabase-')) {
      response.writeHead(200, { 'content-type':'text/javascript' });
      return response.end(`window.supabase={createClient(base){return {rpc:async(name,args)=>{const response=await fetch(base+'/rest/v1/rpc/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args||{})});const value=await response.json();return response.ok?{data:value,error:null}:{data:null,error:value}},auth:{getSession:async()=>({data:{session:null},error:null})}}}};`);
    }
    let body = readFileSync(target);
    if (relative === 'index.html') body = Buffer.from(body.toString().replace(/\s+integrity="[^"]+"/, ''));
    response.writeHead(200, { 'content-type':mime[extname(target)] || 'application/octet-stream', 'cache-control':'no-store' });
    response.end(body);
  } catch (error) {
    unexpected.push(`${request.method} ${request.url}: ${error.message}`);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});

await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless:true });

try {
  const context = await browser.newContext({ serviceWorkers:'block', reducedMotion:'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto(`${origin}/?org=studio-one&service=${ids.service}&utm_source=primetime&utm_medium=shared_link&utm_campaign=booking_link&utm_content=service`);
  try {
    await page.locator('.step[data-step="2"].active').waitFor();
  } catch (error) {
    console.error('acquisition fixture diagnostic', { pageErrors, unexpected, body:await page.locator('body').innerText().catch(() => '') });
    throw error;
  }
  assert.equal(await page.locator(`[data-service="${ids.service}"]`).getAttribute('aria-pressed'), 'true');
  const serviceTrack = calls.find(call => call.name === 'track_public_booking_funnel_event' && call.args.p_event === 'page_opened');
  assert.equal(serviceTrack?.args.p_utm_source, 'primetime');
  assert.equal(serviceTrack?.args.p_utm_medium, 'shared_link');
  assert.equal(serviceTrack?.args.p_utm_content, 'service');

  for (const source of ['yandex', 'google']) {
    const before = calls.length;
    await page.goto(`${origin}/?org=studio-one&utm_source=${source}&utm_medium=maps&utm_campaign=maps_booking_general&utm_content=general`);
    await page.locator('[data-service]').first().waitFor();
    const track = calls.slice(before).find(call => call.name === 'track_public_booking_funnel_event' && call.args.p_event === 'page_opened');
    assert.equal(track?.args.p_source_kind, 'search');
    assert.equal(track?.args.p_utm_source, source);
    assert.equal(track?.args.p_utm_medium, 'maps');
    assert.equal(track?.args.p_utm_campaign, 'maps_booking_general');
    assert.equal(track?.args.p_utm_content, 'general');
  }

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(unexpected, []);
  await context.close();
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

console.log('PrimeTime acquisition browser: PASS for service, Yandex and Google attribution');
