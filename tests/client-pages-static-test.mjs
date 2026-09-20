import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(join(root, file), 'utf8');

for (const forbidden of ['provider.html', 'provider.js', 'provider.webmanifest']) {
  assert.equal(existsSync(join(root, forbidden)), false, `${forbidden} не должен публиковаться в клиентском репозитории`);
}

const manifest = JSON.parse(read('manifest.webmanifest'));
assert.equal(manifest.start_url, './');
assert.equal(manifest.scope, './');
assert.match(manifest.name, /PrimeTime/);

const worker = read('sw.js');
assert.match(worker, /CACHE_PREFIX = 'primetime-client-'/);
assert.match(worker, /CACHE = `\$\{CACHE_PREFIX\}v6`/);
assert.match(worker, /client\.navigate\(new URL\('\.\/', self\.location\.origin\)\.href\)/);
assert.doesNotMatch(worker, /massage-izhevsk-/);
for (const match of worker.matchAll(/'\.\/([^']+)'/g)) {
  const asset = match[1].split('?')[0];
  if (!asset) continue;
  assert.ok(existsSync(join(root, asset)), `В service worker отсутствует файл ${asset}`);
}

const index = read('index.html');
assert.match(index, /https:\/\/primetime-booking\.github\.io\/og\.png/);
assert.doesNotMatch(index, /anatomy-trainer\/#\/home/);
assert.match(index, /catalog-router\.js\?v=6/);
assert.match(read('404.html'), /\/catalog-router\.js\?v=6/);
assert.match(read('site-update.js'), /\.\/sw\.js\?v=6/);

const account = read('my-bookings.html');
assert.match(account, /Восстановить на другом устройстве/);
assert.match(account, /SMS не отправляется/);
assert.match(read('my-bookings.js'), /personalCodeRecovery\.open = !capability\.enabled/);

for (const file of ['index.html', 'booking.html', 'my-bookings.html', 'waitlist.html', 'messages.html', 'privacy.html', 'terms.html', '404.html']) {
  const html = read(file);
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const target = match[1];
    if (/^(?:https?:|#|data:)/.test(target)) continue;
    const asset = target.split('#')[0].split('?')[0];
    if (!asset) continue;
    assert.ok(existsSync(join(root, asset)), `${file} ссылается на отсутствующий ${asset}`);
  }
}

const config = read('config.js');
assert.match(config, /sb_publishable_/);
assert.doesNotMatch(config, /service[_-]?role|SUPABASE_SERVICE_ROLE/i);

console.log('client pages static test: OK');
