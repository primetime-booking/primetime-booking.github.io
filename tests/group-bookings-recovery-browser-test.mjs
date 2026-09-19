import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.env.PRIMETIME_PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PRIMETIME_PLAYWRIGHT_MODULE).href : 'playwright');
const controllerSource = readFileSync(new URL('../group-bookings.js', import.meta.url), 'utf8');
const publicHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless:true });
const pageErrors = [];

async function fixture() {
  const page = await browser.newPage({ viewport:{ width:390, height:844 } });
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => route.fulfill({ contentType:'text/html', body:'<!doctype html><html lang="ru"><meta charset="utf-8"><body></body></html>' }));
  await page.goto('https://group-recovery.test/');
  await page.evaluate(html => {
    const source = new DOMParser().parseFromString(html, 'text/html');
    for (const id of ['publicGroupEvents', 'publicGroupBookingDialog']) {
      const element = source.getElementById(id);
      if (!element) throw new Error(`Missing client HTML fixture #${id}`);
      document.body.append(document.importNode(element, true));
    }
  }, publicHtml);
  await page.addStyleTag({ content:'dialog{max-height:85vh;overflow:auto;width:min(600px,calc(100vw - 24px))}label{display:block;margin:10px 0}input,textarea,button{font:16px sans-serif}button{min-height:44px}' });
  await page.addScriptTag({ content:controllerSource });
  await page.evaluate(async () => {
    const $ = selector => document.querySelector(selector);
    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,
      char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
    const event = { id:'event-a', title:'Существующее занятие', description:'Описание',
      event_date:'2099-05-10', start_time:'12:00:00', duration_minutes:60,
      capacity:6, seats_left:5, status:'published', participants:[],
      performer_id:'performer', performer_name:'Мастер', location_id:'location', location_name:'Кабинет' };
    window.testState = { mode:'success', calls:[], notices:[], settled:0 };
    const db = { rpc:async (name, args) => {
      const state = window.testState;
      state.calls.push({ name, args:structuredClone(args) });
      if (name === 'get_public_minuta_group_events') return { data:{ enabled:true, events:[event] }, error:null };
      try {
        if (state.mode === 'throw') throw new Error('reply lost after commit');
        if (state.mode === 'reject') return { data:null, error:{ code:'22023', message:'invalid_group_participant' } };
        return { data:{ participant_id:'participant-a', booking_code:'GRP-TEST', status:'confirmed' }, error:null };
      } finally { state.settled += 1; }
    } };
    window.controller = window.MinutaGroupBookings.createPublicController({
      db, $, escapeHtml, notify:message => window.testState.notices.push(message), getSlug:() => 'studio'
    });
    window.controller.bind();
    await window.controller.load();
  });
  return page;
}

async function fillForm(page) {
  await page.locator('[data-book-group-event="event-a"]').click();
  await page.locator('#publicGroupClientName').fill('Ирина');
  await page.locator('#publicGroupClientPhone').fill('+79990000000');
  await page.locator('#publicGroupClientComment').fill('Первоначальный комментарий');
  await page.locator('#publicGroupConsent').check();
}

const submit = page => page.locator('#publicGroupBookingForm button[type="submit"]');
async function runCase(title, run) {
  const page = await fixture();
  try { await run(page); console.log(`PASS: ${title}`); }
  finally { await page.close(); }
}

try {
  await runCase('readonly snapshot retries exact public request after ambiguous response', async page => {
    await fillForm(page);
    await page.evaluate(() => { testState.mode = 'throw'; });
    await submit(page).click();
    await page.locator('#publicGroupBookingError').waitFor({ state:'visible' });
    for (const id of ['publicGroupClientName', 'publicGroupClientPhone', 'publicGroupClientComment']) {
      assert.equal(await page.locator(`#${id}`).evaluate(input => input.readOnly), true);
    }
    const name = page.locator('#publicGroupClientName');
    await page.evaluate(() => {
      document.querySelector('#publicGroupClientName').value = 'Программная подмена';
      document.querySelector('#publicGroupClientPhone').value = '+79991111111';
      document.querySelector('#publicGroupClientComment').value = 'Другая заметка';
      testState.mode = 'success';
    });
    await submit(page).click();
    await page.locator('#publicGroupBookingSuccess').waitFor({ state:'visible' });
    const attempts = await page.evaluate(() => testState.calls.filter(call => call.name === 'book_minuta_group_event'));
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1].args, attempts[0].args);
    assert.equal(await name.inputValue(), 'Ирина');
  });

  await runCase('definite rejection releases public inputs for correction', async page => {
    await fillForm(page);
    await page.evaluate(() => { testState.mode = 'reject'; });
    await submit(page).click();
    await page.locator('#publicGroupBookingError').waitFor({ state:'visible' });
    assert.equal(await page.locator('#publicGroupClientName').isEditable(), true);
    await page.locator('#publicGroupClientName').fill('Анна');
    await page.locator('#publicGroupClientPhone').fill('+79992222222');
    await page.locator('#publicGroupClientComment').fill('Исправлено');
    await page.evaluate(() => { testState.mode = 'success'; });
    await submit(page).click();
    await page.locator('#publicGroupBookingSuccess').waitFor({ state:'visible' });
    const attempt = await page.evaluate(() => testState.calls.filter(call => call.name === 'book_minuta_group_event').at(-1));
    assert.equal(attempt.args.p_client_name, 'Анна');
    assert.equal(attempt.args.p_client_phone, '+79992222222');
    assert.equal(attempt.args.p_comment, 'Исправлено');
  });

  assert.deepEqual(pageErrors, []);
} finally {
  await browser.close();
}

console.log('PrimeTime public group booking recovery: 2/2 passed');
