import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PRIMETIME_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PRIMETIME_PLAYWRIGHT_MODULE).href : 'playwright');
const accountHtml = readFileSync(new URL('../my-bookings.html', import.meta.url), 'utf8');
const accountSource = readFileSync(new URL('../my-bookings.js', import.meta.url), 'utf8');
const browser = await chromium.launch({
  headless:true,
  ...(process.platform === 'win32' ? { channel:'msedge' } : {})
});
const sessionToken = 'a'.repeat(64);
const calls = [];
const pageErrors = [];

const recoveredBooking = {
  manage_token:'manage-token', booking_code:'PT-RECOVERED', status:'confirmed',
  performer_name:'Елена Морозова', service_name:'Восстановительный массаж',
  booking_date:'2099-05-10', booking_time:'14:00:00', duration_minutes:60,
  price_rub:2200, deposit_amount_rub:0, payment_status:'not_required',
  service_active:true, service_id:'11111111-1111-4111-8111-111111111111',
  review_eligible:false
};

async function fixture(width) {
  const page = await browser.newPage({ viewport:{ width, height:900 } });
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => route.fulfill({
    contentType:'text/html',
    body:'<!doctype html><html lang="ru"><meta charset="utf-8"><body></body></html>'
  }));
  await page.goto('https://device-recovery.test/my-bookings.html');
  await page.evaluate(html => {
    const source = new DOMParser().parseFromString(html, 'text/html');
    document.body.replaceWith(document.importNode(source.body, true));
  }, accountHtml);
  await page.addStyleTag({ content:'body{font:16px system-ui;margin:0;padding:16px}input,button,summary{min-height:44px}details,form{display:block;max-width:560px}label{display:block;margin:10px 0}.client-booking-item{margin-top:16px}' });
  await page.evaluate(({ sessionToken, recoveredBooking }) => {
    window.MINUTA_CONFIG = { supabaseUrl:'https://example.invalid', supabaseKey:'public-test-key' };
    window.MinutaPhoneAuth = {
      capability:async () => ({ enabled:false, reason:'not_configured' }),
      formatPhone:value => value,
      formatCode:value => value,
      message:() => 'SMS disabled in this recovery test'
    };
    window.supabase = { createClient:() => ({
      rpc:async (name, args) => {
        window.testCalls.push({ name, args:structuredClone(args) });
        if (name === 'login_client_access') return { data:[{ session_token:sessionToken }], error:null };
        if (name === 'restore_client_session') return { data:[{
          normalized_phone:'+79990000000', session_expires_at:'2099-12-01T10:00:00.000Z'
        }], error:null, status:200 };
        if (name === 'get_client_bookings_v3') return { data:[recoveredBooking], error:null };
        throw new Error(`Unexpected RPC ${name}`);
      },
      auth:{ getSession:async () => ({ data:{ session:null } }), signOut:async () => ({}) }
    }) };
    window.testCalls = [];
  }, { sessionToken, recoveredBooking });
  await page.addScriptTag({ content:accountSource });
  return page;
}

try {
  for (const width of [390, 760, 1440]) {
    const page = await fixture(width);
    const recovery = page.locator('#legacyClientLogin');
    assert.equal(await recovery.getAttribute('open'), '', `personal-code recovery must open at ${width}px`);
    await page.locator('#clientLoginPhone').fill('+7 (999) 000-00-00');
    await page.locator('#clientLoginCode').fill('ABCD-EF01-2345-6789');
    await page.getByRole('button', { name:'Открыть мои записи' }).click();
    await page.getByText('Восстановительный массаж').waitFor({ state:'visible' });
    assert.equal(await page.evaluate(() => sessionStorage.getItem('minuta-client-session-v1')), sessionToken);
    const dimensions = await page.locator('html').evaluate(element => ({
      clientWidth:element.clientWidth,
      scrollWidth:element.scrollWidth
    }));
    assert.equal(dimensions.scrollWidth, dimensions.clientWidth, `no overflow at ${width}px`);
    calls.push(...await page.evaluate(() => window.testCalls));
    await page.close();
  }
  assert.equal(calls.filter(call => call.name === 'login_client_access').length, 3);
  assert.equal(calls.some(call => /sms/i.test(call.name)), false);
  assert.deepEqual(pageErrors, []);
} finally {
  await browser.close();
}

console.log('PrimeTime cross-device personal-code recovery: 390/760/1440 passed');
