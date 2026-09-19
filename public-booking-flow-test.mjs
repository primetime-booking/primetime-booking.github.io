import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(root, 'app.js'), 'utf8');

const renderTimesSource = app.match(/function renderTimes\(\) \{[\s\S]*?\n\}(?=\r?\n\r?\nfunction renderAvailabilitySuggestion)/)?.[0] || '';
assert.ok(renderTimesSource, 'Не удалось извлечь отрисовку времени');

function runRenderTimes(times, { loading = false, suggestionShown = false } = {}) {
  const elements = new Map([
    ['#durationNote', { innerHTML:'' }],
    ['#timePeriods', { innerHTML:'' }],
    ['#timeHours', { innerHTML:'', hidden:false }],
    ['#minutePicker', { hidden:false, open:false }],
    ['#times', { innerHTML:'' }],
    ['#continueBooking', { disabled:false }],
    ['#noTimes', { hidden:false }],
    ['#waitlistCta', { hidden:false }]
  ]);
  const state = {
    availability:new Map([['2099-09-07', times]]),
    date:'2099-09-07',
    time:'',
    loadingAvailability:loading,
    availabilityError:false,
    teamMode:false
  };
  const renderTimes = Function(
    'state', '$', 'selectedService', 'timeRange', 'durationLabel', 'escapeHtml', 'renderAvailabilitySuggestion', 'availableBusinessTimes',
    `${renderTimesSource}; return renderTimes;`
  )(
    state,
    selector => elements.get(selector),
    () => ({ duration_minutes:60 }),
    (time) => `${time}–${String(Number(time.slice(0, 2)) + 1).padStart(2, '0')}:00`,
    value => `${value} мин`,
    value => String(value),
    () => suggestionShown,
    (_date, times) => times
  );
  renderTimes();
  return elements;
}

const emptyDay = runRenderTimes([], { suggestionShown:true });
assert.equal(emptyDay.get('#timeHours').hidden, true, 'Сетка недоступных часов заслоняет ближайшее свободное окно');
assert.equal(emptyDay.get('#noTimes').hidden, true, 'Дублирующее сообщение показывается рядом с ближайшим окном');

const availableDay = runRenderTimes(['10:00']);
assert.equal(availableDay.get('#timeHours').hidden, false, 'Доступные часы ошибочно скрыты');
assert.match(emptyDay.get('#timeHours').innerHTML, /disabled/, 'Скрывается только заведомо недоступная сетка, а не изменяется расчёт слотов');

const loadingDay = runRenderTimes([], { loading:true });
assert.equal(loadingDay.get('#timeHours').hidden, false, 'Индикатор загрузки расписания скрыт');
assert.match(loadingDay.get('#timeHours').innerHTML, /Ищем свободное время/, 'Нет понятного состояния загрузки');

const suggestedHandler = app.match(/if \(suggestedDate\) \{[\s\S]*?\n  \}/)?.[0] || '';
assert.ok(suggestedHandler, 'Не найден обработчик ближайшего свободного окна');
assert.match(suggestedHandler, /state\.date = suggestedDate\.dataset\.suggestedDate;/, 'Предложенная дата не выбирается');
assert.match(suggestedHandler, /state\.time = suggestedDate\.dataset\.suggestedTime;/, 'Предложенное время не выбирается');
assert.match(suggestedHandler, /renderTimes\(\);\s*void showStep\(3\);/, 'Ближайшее окно требует лишнего нажатия «Ввести контакты»');
assert.match(app, /if \(time && !time\.disabled\)[^{]*\{[\s\S]*?void showStep\(3\); \}/, 'Обычный свободный слот не открывает контакты автоматически');

assert.match(app, /function contactFormIsComplete\(\)[\s\S]*name\.length >= 2[\s\S]*phoneDigits\.length === 11[\s\S]*dataConsent/, 'Автопереход обходит обязательные контактные данные или согласие');
assert.match(app, /if \(!\$\('#dataConsent'\)\.checked\) \{ showError\('Подтвердите согласие на обработку данных\.'\); return; \}/, 'Отправка записи больше не требует согласия');
assert.match(app, /if \(!available\) \{[\s\S]*state\.time = '';[\s\S]*await showStep\(2\);/, 'Серверная перепроверка не возвращает клиента к выбору занятого времени');

console.log('public booking flow test: OK');
