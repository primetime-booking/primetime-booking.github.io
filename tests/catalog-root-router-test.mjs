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
assert.equal(route('/', '?org=minuta-example&service=service-id'), '');
assert.equal(route('/', '?provider=provider-id'), '');
assert.equal(route('/favorites'), `${catalog}/favorites`);
assert.equal(route('/map/'), `${catalog}/map/`);
assert.equal(route('/bookings', '?source=old'), `${catalog}/bookings?source=old`);
assert.equal(
  route('/r/ramil', '?service=massage&slot=10%3A00&returnTo=%2Fnearby'),
  `${catalog}/r/ramil?service=massage&slot=10%3A00&returnTo=%2Fnearby`
);
assert.equal(route('/master/elena-morozova', '?org=drop&from=catalog'), `${catalog}/master/elena-morozova?from=catalog`);
assert.equal(route('/api/catalog'), '');
assert.equal(route('/unknown'), '');
assert.equal(route('/', '', '', 'localhost'), '');

console.log('catalog root router test: OK');
