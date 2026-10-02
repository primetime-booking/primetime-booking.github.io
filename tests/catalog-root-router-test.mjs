import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../catalog-router.js', import.meta.url), 'utf8');

function route(pathname, search = '', hash = '', hostname = 'primetime-booking.github.io') {
  let replacement = '';
  const location = {
    hostname,
    pathname,
    search,
    hash,
    replace(value) { replacement = value; }
  };
  vm.runInNewContext(source, { window:{ location }, URL, URLSearchParams });
  return replacement;
}

const catalog = 'https://primetime-booking.primetime-booking-ru.workers.dev';
assert.equal(route('/'), `${catalog}/r/ramil`);
assert.equal(route('/index.html', '', '#/home'), `${catalog}/r/ramil`);
assert.equal(
  route('/', '?utm_source=old&utm_campaign=launch&unknown=drop', '#/home'),
  `${catalog}/r/ramil?utm_source=old&utm_campaign=launch`
);
assert.equal(route('/', '?org=minuta-example&service=service-id'), `${catalog}/legacy-booking?org=minuta-example&service=service-id`);
assert.equal(route('/', '?provider=provider-id'), `${catalog}/legacy-booking?provider=provider-id`);
assert.equal(route('/', '?org=one&org=two&service=bad&theme=warm'), `${catalog}/legacy-booking?org=one&org=two&service=bad`);
assert.equal(route('/', '?org=one&group=bad'), `${catalog}/legacy-booking?org=one&group=bad`);
assert.equal(route('/', '?org=one&embed=1', '#private'), `${catalog}/legacy-booking?legacyHash=%23private&org=one&embed=1`);
assert.equal(route('/index.html', '?org=one', '#/home'), `${catalog}/legacy-booking?org=one`);
assert.equal(route('/favorites'), `${catalog}/favorites`);
assert.equal(route('/map/'), `${catalog}/map/`);
assert.equal(route('/bookings', '?source=old'), `${catalog}/bookings?source=old`);
assert.equal(
  route('/r/ramil', '?service=massage&slot=10%3A00&returnTo=%2Fnearby'),
  `${catalog}/r/ramil?service=massage&slot=10%3A00&returnTo=%2Fnearby`
);
assert.equal(route('/master/elena-morozova', '?org=drop&from=catalog'), `${catalog}/master/elena-morozova?from=catalog`);
assert.equal(route('/api/catalog'), '');
assert.equal(route('/booking.html', '?token=historical'), '');
assert.equal(route('/my-bookings.html', '?restore=historical'), '');
assert.equal(route('/messages.html'), '');
assert.equal(route('/privacy.html'), '');
assert.equal(route('/unknown'), '');
assert.equal(route('/', '', '', 'localhost'), '');

console.log('catalog root router test: OK');
