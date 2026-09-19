const db = window.supabase.createClient(window.MINUTA_CONFIG.supabaseUrl, window.MINUTA_CONFIG.supabaseKey);
const telegramClientEndpoint = `${window.MINUTA_CONFIG.supabaseUrl}/functions/v1/telegram-client-notify`;
const yookassaPaymentEndpoint = `${window.MINUTA_CONFIG.supabaseUrl}/functions/v1/yookassa-create-payment`;
const $ = selector => document.querySelector(selector);
const token = new URLSearchParams(location.search).get('token') || new URLSearchParams(location.hash.slice(1)).get('token') || '';
if (new URLSearchParams(location.search).has('token')) history.replaceState({}, '', `booking.html#token=${encodeURIComponent(token)}`);
applyStoredClientTheme();
document.querySelector('#clientDataRights')?.addEventListener('click',async event=>{const button=event.target.closest('[data-client-data-request]');if(!button||!token)return;const status=document.querySelector('#clientDataRequestStatus');button.disabled=true;if(status)status.textContent='Отправляем запрос...';try{const{data,error}=await db.rpc('submit_minuta_client_data_request_v108',{p_token:token,p_request_type:button.dataset.clientDataRequest});if(error)throw error;if(status)status.textContent=`Запрос принят. Номер: ${data}`}catch(error){if(status)status.textContent=error?.message||'Не удалось отправить запрос.'}finally{button.disabled=false}});
const state = { booking: null, paymentCapability: null, dates: [], availability: new Map(), date: '', time: '' };
let bookingLoadRevision = 0;
let mutationBusy = false;
let rescheduleAttempt = null;
let rescheduleStorageKey = '';
let uncertainAction = '';

function mutationLocked() { return mutationBusy || Boolean(rescheduleAttempt) || Boolean(uncertainAction); }
function applyMutationLock() {
  if (!mutationLocked()) return;
  for (const element of document.querySelectorAll('#openReschedule, #cancelBooking, #confirmAttendance, #confirmReschedule, #closeReschedule, [data-manage-date], [data-manage-time]')) element.disabled = true;
  $('#checkManageResult').disabled = mutationBusy;
}
function showRecovery(message, action = 'reschedule') {
  uncertainAction = action;
  $('#manageRecoveryText').textContent = message;
  $('#manageRecovery').hidden = false;
  $('#reschedulePanel').hidden = true;
  $('#manageActions').hidden = false;
  applyMutationLock();
  $('#manageRecovery').scrollIntoView({ block:'nearest' });
}
function clearRecovery() {
  uncertainAction = '';
  $('#manageRecovery').hidden = true;
}
function clearRescheduleAttempt() {
  try { sessionStorage.removeItem(rescheduleStorageKey); } catch {}
  rescheduleAttempt = null;
}
async function initializeManagement() {
  try {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    rescheduleStorageKey = `minuta-reschedule-attempt-v1:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const saved = JSON.parse(sessionStorage.getItem(rescheduleStorageKey) || 'null');
    if (saved && /^[0-9a-f-]{36}$/i.test(saved.requestId || '') && /^\d{4}-\d{2}-\d{2}$/.test(saved.date || '') && /^\d{2}:\d{2}$/.test(saved.time || '')) {
      rescheduleAttempt = saved;
      showRecovery('Предыдущий перенос ещё не проверен. Проверьте его результат перед новым действием.');
    }
  } catch {}
  await loadBooking();
}
async function checkManagementResult() {
  if (mutationBusy) return;
  if (rescheduleAttempt) { await performReschedule(); return; }
  mutationBusy = true; applyMutationLock();
  try {
    if (await loadBooking({ silent:true })) { clearRecovery(); renderBooking(); }
  } finally { mutationBusy = false; if (state.booking) renderBooking(); $('#checkManageResult').disabled = false; }
}

function applyStoredClientTheme() {
  const catalog = window.MinutaThemeCatalog;
  if (!catalog) return;
  let theme = catalog.settingsFromSearch(location.search).theme_key;
  try {
    const saved = JSON.parse(localStorage.getItem('minuta-client-active-presentation-v1') || 'null');
    if (saved?.theme && Date.now() - Number(saved.savedAt || 0) < 30 * 24 * 60 * 60 * 1000) theme = saved.theme;
  } catch {}
  catalog.applyClientTheme(document.body, theme);
}

function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function createRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function httpsPaymentUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
function paymentRequestId(manageToken) {
  const key = `minuta-payment-request-v1:${manageToken}`;
  try {
    const saved = sessionStorage.getItem(key);
    if (/^[0-9a-f-]{36}$/i.test(saved || '')) return saved;
    const created = createRequestId();
    sessionStorage.setItem(key, created);
    return created;
  } catch { return createRequestId(); }
}
async function getPaymentCapability() {
  try {
    const { data, error } = await db.rpc('get_yookassa_payment_capability', { p_manage_token: token });
    return error || !data || typeof data !== 'object' || Array.isArray(data) ? null : data;
  } catch { return null; }
}
function isMissingRpc(error, name) {
  const text = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''}`;
  return /PGRST202|42883/i.test(text) || new RegExp(`function\\s+[^\\n]*${name}[^\\n]*does not exist`, 'i').test(text);
}
function money(value) { return `${new Intl.NumberFormat('ru-RU').format(value)} ₽`; }
function serviceName(value) { return value === 'Общий массаж задней поверхности' ? 'Массаж задней поверхности тела' : value; }
// Matches the deployed booking-policy and availability SQL contract.
const BUSINESS_TIME_ZONE = 'Europe/Samara';
function businessClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone:BUSINESS_TIME_ZONE, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(now).map(part => [part.type,part.value]));
  return { date:`${parts.year}-${parts.month}-${parts.day}`, time:`${parts.hour}:${parts.minute}` };
}
function availableBusinessTimes(date, times) {
  const now = businessClock();
  return times.filter(time => `${date}T${String(time).slice(0,5)}` > `${now.date}T${now.time}`);
}
function localIsoDate(date) { return date.toISOString().slice(0,10); }
function notify(message) { const toast = $('#toast'); toast.textContent = message; toast.hidden = false; clearTimeout(notify.timer); notify.timer = setTimeout(() => { toast.hidden = true; }, 2800); }
function prepareTelegramAuthorization() {
  return window.MinutaTelegramAuth?.prepare({
    button: $('#manageTelegramConnect'),
    manageToken: token,
    endpoint: telegramClientEndpoint,
    apikey: window.MINUTA_CONFIG.supabaseKey,
    onConnected: () => notify('Telegram-уведомления подключены')
  });
}
function notifyTelegramEvent(event) {
  return fetch(`${telegramClientEndpoint}/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: window.MINUTA_CONFIG.supabaseKey },
    body: JSON.stringify({ event, manage_token: token })
  }).catch(() => null);
}
function deadlineLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function setFreshness(kind, text) {
  const element = $('#manageFreshness');
  element.className = `manage-freshness ${kind === 'stale' ? 'is-stale' : ''}`;
  element.textContent = text;
}
function markBookingStale(text = 'Не удалось обновить данные — показана сохранённая на экране версия.') {
  setFreshness('stale', text);
  $('#openReschedule').disabled = true;
  $('#cancelBooking').disabled = true;
  $('#confirmReschedule').disabled = true;
  $('#confirmAttendance').disabled = true;
  $('#reschedulePanel').hidden = true;
  $('#manageActions').hidden = false;
  $('#managePaymentLink').hidden = true;
  delete $('#managePaymentLink').dataset.paymentToken;
  showRecovery('Не удалось проверить актуальное состояние записи. Восстановите соединение и нажмите «Проверить результат».', uncertainAction || 'refresh');
}

async function startOnlinePayment(link) {
  if (link.getAttribute('aria-busy') === 'true') return;
  const fallbackUrl = httpsPaymentUrl(link.getAttribute('href'));
  if (!navigator.onLine) {
    if (fallbackUrl) location.href = fallbackUrl;
    else notify('Для оплаты требуется интернет');
    return;
  }
  link.setAttribute('aria-busy', 'true');
  const previous = link.textContent;
  link.textContent = 'Открываем оплату…';
  try {
    const response = await fetch(yookassaPaymentEndpoint, {
      method:'POST',
      headers:{ 'content-type':'application/json', apikey:window.MINUTA_CONFIG.supabaseKey },
      body:JSON.stringify({ manage_token:token, request_id:paymentRequestId(token) })
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok && result?.ok && result.status === 'succeeded') {
      link.removeAttribute('aria-busy');
      link.textContent = previous;
      await loadBooking({ silent:true });
      notify('Оплата уже подтверждена');
      return;
    }
    const paymentUrl = httpsPaymentUrl(result?.payment_url);
    if (!response.ok || !result?.ok || !paymentUrl) throw new Error(result?.error || 'payment_unavailable');
    location.href = paymentUrl;
  } catch {
    link.removeAttribute('aria-busy');
    link.textContent = previous;
    if (fallbackUrl) location.href = fallbackUrl;
    else notify('Не удалось открыть оплату. Попробуйте снова позже.');
  }
}

function createDates() {
  const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone:'UTC' });
  const first = new Date(`${businessClock().date}T12:00:00Z`);
  return Array.from({ length: 14 }, (_, index) => {
    const date = new Date(first); date.setUTCDate(date.getUTCDate() + index);
    return { iso: localIsoDate(date), day: date.getUTCDate(), weekday: weekday.format(date).replace('.', '') };
  });
}

function renderBooking() {
  const item = state.booking;
  const date = new Date(`${item.booking_date}T12:00:00`);
  const statusMap = { new: 'Ожидает подтверждения', confirmed: 'Подтверждена', cancelled: 'Отменена' };
  $('#manageService').textContent = serviceName(item.service_name);
  $('#manageStatus').textContent = statusMap[item.status] || item.status;
  $('#manageStatus').className = `manage-status status-${item.status}`;
  $('#manageDay').textContent = String(date.getDate());
  $('#manageMonth').textContent = date.toLocaleDateString('ru-RU', { month: 'short' }).replace('.', '');
  $('#manageDate').textContent = date.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('#manageTime').textContent = `Начало в ${String(item.booking_time).slice(0, 5)} по Самаре (UTC+4)`;
  $('#managePerformer').textContent = item.performer_name;
  $('#manageDuration').textContent = `${item.duration_minutes} мин`;
  $('#managePrice').textContent = money(item.price_rub);
  const cancelled = item.status === 'cancelled';
  $('#attendanceConfirmation').hidden = item.status !== 'new';
  $('#confirmAttendance').disabled = item.status !== 'new';
  $('#openReschedule').disabled = cancelled || !item.reschedule_allowed;
  $('#cancelBooking').disabled = cancelled || !item.cancel_allowed;
  if (!$('#reschedulePanel').hidden) $('#confirmReschedule').disabled = !state.time;
  $('#cancelBooking').textContent = 'Отменить запись';
  const policy = $('#managePolicy');
  if (cancelled) policy.textContent = 'Запись отменена.';
  else {
    const parts = [];
    if (item.reschedule_allowed) parts.push(`перенос доступен до ${deadlineLabel(item.reschedule_deadline)} · осталось ${item.reschedules_remaining}`);
    else parts.push('самостоятельный перенос уже недоступен');
    if (item.cancel_allowed) parts.push(`отмена доступна до ${deadlineLabel(item.cancel_deadline)}`);
    else parts.push('самостоятельная отмена уже недоступна');
    policy.textContent = parts.join('; ');
  }
  const payment = $('#managePayment');
  const deposit = Number(item.deposit_amount_rub || 0);
  payment.hidden = deposit <= 0;
  if (deposit > 0) {
    const labels = { pending: 'Ожидается', paid: 'Оплачено', refunded: 'Возвращено', not_required: 'Не требуется' };
    const refundLabels = { pending: 'Возврат оформляется', refunded: 'Возвращено', denied: 'Без возврата' };
    $('#manageDeposit').textContent = money(deposit);
    const cancelledWithoutCharge = cancelled && item.payment_status === 'pending' && (!item.refund_status || item.refund_status === 'not_required');
    const paymentLabel = cancelledWithoutCharge ? 'Оплата отменена' : refundLabels[item.refund_status]
      || (item.payment_status === 'pending' && item.payment_due_at ? `Оплатить до ${deadlineLabel(item.payment_due_at)}` : labels[item.payment_status] || item.payment_status);
    $('#managePaymentStatus').textContent = paymentLabel;
    $('#managePaymentStatus').className = `payment-status status-${cancelledWithoutCharge || item.refund_status === 'refunded' ? 'refunded' : item.payment_status}`;
    const link = $('#managePaymentLink');
    const dueAt = item.payment_due_at ? new Date(item.payment_due_at).getTime() : Number.POSITIVE_INFINITY;
    const legacyUrl = httpsPaymentUrl(item.payment_url);
    const capabilityUrl = httpsPaymentUrl(state.paymentCapability?.payment_url);
    const fallbackUrl = httpsPaymentUrl(state.paymentCapability?.fallback_url) || legacyUrl;
    const canPay = !cancelled && item.payment_status === 'pending' && dueAt > Date.now();
    const hasPaymentRoute = state.paymentCapability ? state.paymentCapability.available === true : Boolean(legacyUrl);
    const canStartPayment = canPay && hasPaymentRoute;
    const canCreate = canStartPayment && state.paymentCapability?.can_create === true;
    link.hidden = !canStartPayment;
    link.href = capabilityUrl || fallbackUrl || '#';
    delete link.dataset.paymentToken;
    if (canCreate) link.dataset.paymentToken = token;
  }
  setFreshness('fresh', `Проверено в ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`);
  if (cancelled) $('#manageActions').classList.add('cancelled');
  applyMutationLock();
}

async function confirmAttendance() {
  if (mutationLocked()) return;
  mutationBusy = true;
  const button = $('#confirmAttendance');
  button.disabled = true;
  button.textContent = 'Подтверждаем…';
  applyMutationLock();
  try {
    try { await db.rpc('confirm_booking_by_token', { p_token: token }); } catch {}
    const verified = await loadBooking({ silent:true });
    if (verified && state.booking.status === 'confirmed') { clearRecovery(); notify('Визит подтверждён'); }
    else if (verified) { clearRecovery(); notify('Подтверждение визита не найдено. Проверьте актуальный статус записи.'); }
    else showRecovery('Результат подтверждения визита пока неизвестен. Нажмите «Проверить результат».', 'attendance');
  } finally {
    mutationBusy = false;
    button.textContent = 'Да, я приду';
    if (state.booking) renderBooking();
    $('#checkManageResult').disabled = false;
  }
}

async function loadBooking(options = {}) {
  const revision = ++bookingLoadRevision;
  if (!options.silent) {
    $('#manageLoading').hidden = false;
    $('#manageError').hidden = true;
  }
  if (!/^[0-9a-f-]{36}$/i.test(token)) { if (!options.silent) showNotFound(); return false; }
  const paymentCapabilityPromise = getPaymentCapability();
  let data, error;
  try {
    ({ data, error } = await db.rpc('get_booking_management_v2', { p_token: token }));
    if (error && isMissingRpc(error, 'get_booking_management_v2')) ({ data, error } = await db.rpc('get_booking_management', { p_token: token }));
  } catch (caught) { error = caught; }
  const paymentCapability = await paymentCapabilityPromise;
  if (revision !== bookingLoadRevision) return false;
  if (error) { if (!options.silent) showLoadError(); else markBookingStale(); return false; }
  if (!data?.length) { if (!options.silent) showNotFound(); else markBookingStale('Запись больше не найдена — обновите страницу или свяжитесь с исполнителем.'); return false; }
  state.booking = data[0];
  state.paymentCapability = paymentCapability;
  $('#manageLoading').hidden = true;
  $('#manageContent').hidden = false;
  void prepareTelegramAuthorization();
  renderBooking();
  return true;
}

function showNotFound() {
  $('#manageLoading').hidden = true;
  $('#manageError').hidden = false;
  $('#manageErrorTitle').textContent = 'Запись не найдена';
  $('#manageErrorText').textContent = 'Проверьте полную ссылку из подтверждения или откройте «Мои записи». Не создавайте повторную запись для восстановления доступа.';
  $('#retryManage').hidden = true;
}
function showLoadError() {
  $('#manageLoading').hidden = true;
  $('#manageError').hidden = false;
  $('#manageErrorTitle').textContent = navigator.onLine ? 'Не удалось проверить запись' : 'Нет соединения с интернетом';
  $('#manageErrorText').textContent = 'Повторите проверку, когда соединение восстановится.';
  $('#retryManage').hidden = false;
}

function renderDates() {
  $('#manageDates').innerHTML = state.dates.map(item => {
    const slots = availableBusinessTimes(item.iso, state.availability.get(item.iso) || []);
    const unavailable = !slots.length;
    const disabled = unavailable || mutationLocked();
    return `<button class="date ${item.iso === state.date ? 'selected' : ''} ${unavailable ? 'unavailable' : ''}" type="button" data-manage-date="${item.iso}" ${disabled ? 'disabled' : ''}><small>${item.weekday}</small><strong>${item.day}</strong>${unavailable ? '<i>нет мест</i>' : ''}</button>`;
  }).join('');
}

function renderTimes() {
  const times = availableBusinessTimes(state.date, state.availability.get(state.date) || []);
  if (!times.includes(state.time)) state.time = times[0] || '';
  $('#manageTimes').innerHTML = times.map(time => `<button class="time ${time === state.time ? 'selected' : ''}" type="button" data-manage-time="${time}">${time}</button>`).join('');
  $('#manageNoTimes').hidden = Boolean(times.length);
  $('#confirmReschedule').disabled = !state.time || mutationLocked();
  applyMutationLock();
}

async function openReschedule() {
  if (mutationLocked()) return;
  $('#manageFormError').hidden = true;
  $('#reschedulePanel').hidden = false;
  $('#manageActions').hidden = true;
  state.dates = createDates();
  state.date = state.dates[0].iso;
  state.time = '';
  $('#manageDates').innerHTML = '<div class="loading-state compact"><i></i><span>Ищем свободные даты…</span></div>';
  $('#manageTimes').innerHTML = '';
  const parameters = { p_token: token, p_start: state.dates[0].iso, p_end: state.dates[state.dates.length - 1].iso };
  let { data, error } = await db.rpc('get_reschedule_slots_v101', parameters);
  if (error && isMissingRpc(error, 'get_reschedule_slots_v101')) {
    ({ data, error } = await db.rpc('get_minuta_group_safe_reschedule_slots', parameters));
  }
  if (error && isMissingRpc(error, 'get_minuta_group_safe_reschedule_slots')) {
    ({ data, error } = await db.rpc('get_reschedule_slots_v5', parameters));
  }
  if (error && isMissingRpc(error, 'get_reschedule_slots_v5')) {
    ({ data, error } = await db.rpc('get_reschedule_slots_v4', parameters));
  }
  if (error && isMissingRpc(error, 'get_reschedule_slots_v4')) {
    ({ data, error } = await db.rpc('get_reschedule_slots_v3', parameters));
  }
  if (error && isMissingRpc(error, 'get_reschedule_slots_v3')) {
    ({ data, error } = await db.rpc('get_reschedule_slots', parameters));
  }
  state.dates.forEach(item => state.availability.set(item.iso, []));
  if (!error) (data || []).forEach(item => state.availability.set(item.booking_date, [...(state.availability.get(item.booking_date) || []), String(item.booking_time).slice(0, 5)]));
  const first = state.dates.find(item => (state.availability.get(item.iso) || []).length);
  if (first) state.date = first.iso;
  renderDates(); renderTimes();
  if (error) {
    const message = error.message || '';
    $('#manageFormError').textContent = message.includes('reschedule_too_late') ? 'Срок самостоятельного переноса уже закончился.' : message.includes('reschedule_limit_reached') ? 'Лимит самостоятельных переносов исчерпан.' : 'Не удалось загрузить свободное время.';
    $('#manageFormError').hidden = false;
  }
  $('#reschedulePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeReschedule() { if (mutationBusy) return; $('#reschedulePanel').hidden = true; $('#manageActions').hidden = false; }

async function confirmReschedule() {
  if (!state.time || mutationLocked()) return;
  if (!availableBusinessTimes(state.date, [state.time]).length) { renderDates(); renderTimes(); notify('Это время уже прошло по Самаре. Выберите другое.'); return; }
  const attempt = { requestId:createRequestId(), date:state.date, time:state.time };
  try {
    if (!rescheduleStorageKey) throw new Error('storage_unavailable');
    sessionStorage.setItem(rescheduleStorageKey, JSON.stringify(attempt));
    if (sessionStorage.getItem(rescheduleStorageKey) !== JSON.stringify(attempt)) throw new Error('storage_unavailable');
  } catch { notify('Для безопасного переноса разрешите хранение данных сайта и обновите страницу.'); return; }
  rescheduleAttempt = attempt;
  await performReschedule();
}

async function performReschedule() {
  if (mutationBusy || !rescheduleAttempt) return;
  mutationBusy = true;
  const attempt = rescheduleAttempt;
  const button = $('#confirmReschedule');
  button.disabled = true; button.textContent = 'Сохраняем…';
  applyMutationLock();
  let refreshSlots = false;
  let rejectionMessage = '';
  try {
    let reply;
    try { reply = await db.rpc('reschedule_booking_v2', { p_token:token, p_date:attempt.date, p_time:`${attempt.time}:00`, p_request_id:attempt.requestId }); }
    catch (error) { reply = { error }; }
    const error = reply?.error;
    if (!error && typeof reply?.data === 'string' && reply.data) {
      if (await loadBooking({ silent:true })) {
        clearRescheduleAttempt(); clearRecovery();
        $('#reschedulePanel').hidden = true; $('#manageActions').hidden = false;
        notifyTelegramEvent('rescheduled'); notify('Перенос выполнен. Показано актуальное состояние записи.');
        return;
      }
    }
    const rejection = error?.code === 'P0001' && /^(slot_unavailable|booking_buffer_conflict|reschedule_too_late|reschedule_limit_reached|booking_unavailable|request_conflict)$/.test(error.message || '');
    if (rejection || error?.code === '23P01') {
      clearRescheduleAttempt(); clearRecovery();
      await loadBooking({ silent:true });
      refreshSlots = !uncertainAction && (['slot_unavailable','booking_buffer_conflict'].includes(error.message) || error.code === '23P01');
      $('#manageFormError').textContent = error.message === 'reschedule_limit_reached' ? 'Лимит самостоятельных переносов исчерпан.' : error.message === 'reschedule_too_late' ? 'Срок самостоятельного переноса закончился.' : 'Перенос не выполнен. Проверьте запись и выберите доступное время.';
      rejectionMessage = $('#manageFormError').textContent;
      $('#manageFormError').hidden = false;
      notify($('#manageFormError').textContent);
      return;
    }
    showRecovery('Результат переноса пока неизвестен. «Проверить результат» безопасно повторит ту же операцию и не создаст второй перенос.');
  } finally {
    mutationBusy = false;
    button.textContent = 'Сохранить новое время';
    if (state.booking) renderBooking();
    $('#checkManageResult').disabled = false;
    $('#closeReschedule').disabled = mutationLocked();
    if (!$('#reschedulePanel').hidden) { renderDates(); renderTimes(); }
    if (refreshSlots) { await openReschedule(); $('#manageFormError').textContent = rejectionMessage; $('#manageFormError').hidden = false; }
  }
}

async function cancelBooking() {
  if (mutationLocked()) return;
  mutationBusy = true; applyMutationLock();
  try { await cancelBookingOperation(); }
  catch { showRecovery('Результат отмены пока неизвестен. Нажмите «Проверить результат».', 'cancel'); }
  finally { mutationBusy = false; if (state.booking) renderBooking(); $('#checkManageResult').disabled = false; }
}
async function cancelBookingOperation() {
  if (!confirm('Отменить эту запись?')) return;
  const button = $('#cancelBooking'); button.disabled = true; button.textContent = 'Отменяем…';
  let { error } = await db.rpc('cancel_booking_v2', { p_token: token });
  if (error && isMissingRpc(error, 'cancel_booking_v2')) ({ error } = await db.rpc('cancel_booking', { p_token: token }));
  if (error) {
    if (error.message?.includes('cancel_too_late')) {
      notify('Срок самостоятельной отмены закончился — свяжитесь с исполнителем');
      await loadBooking({ silent: true });
      return;
    }
    const verified = await loadBooking({ silent: true });
    button.disabled = !verified || state.booking?.status === 'cancelled'; button.textContent = 'Отменить запись';
    if (verified && state.booking.status === 'cancelled') { notifyTelegramEvent('cancelled'); notify('Запись отменена'); return; }
    if (!verified) { button.disabled = true; button.textContent = 'Сначала обновите запись'; }
    notify('Результат отмены не подтверждён — обновите запись перед повтором');
    return;
  }
  notifyTelegramEvent('cancelled');
  notify('Запись отменена'); await loadBooking();
}

function calendarStartMs(date, time, addMinutes = 0) {
  const [year, month, day] = String(date).split('-').map(Number);
  const [hour, minute] = String(time).slice(0, 5).split(':').map(Number);
  return Date.UTC(year, month - 1, day, hour - 4, minute + addMinutes);
}
function calendarTimestamp(date, time, addMinutes = 0) { return new Date(calendarStartMs(date, time, addMinutes)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }

function calendarUtcTimestamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
function calendarText(value) { return String(value).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1'); }

function calendarEvent() {
  const item = state.booking;
  return {
    title: `${item.service_name} — Массаж в Ижевске`,
    description: `Исполнитель: ${item.performer_name}`,
    location: 'Ижевск, ул. Карла Маркса, 304б',
    startMs: calendarStartMs(item.booking_date, item.booking_time),
    endMs: calendarStartMs(item.booking_date, item.booking_time, item.duration_minutes),
    start: calendarTimestamp(item.booking_date, item.booking_time),
    end: calendarTimestamp(item.booking_date, item.booking_time, item.duration_minutes)
  };
}

function calendarFile() {
  const item = state.booking;
  const event = calendarEvent();
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'PRODID:-//MassageIzhevsk//Booking//RU', 'BEGIN:VEVENT', `UID:${item.booking_code}@massage-izhevsk`, `DTSTAMP:${calendarUtcTimestamp()}`, `DTSTART:${event.start}`, `DTEND:${event.end}`, `SUMMARY:${calendarText(event.title)}`, `DESCRIPTION:${calendarText(event.description)}`, `LOCATION:${calendarText(event.location)}`, 'END:VEVENT', 'END:VCALENDAR', ''];
  const name = `massage-${item.booking_date}-${String(item.booking_time).slice(0, 5).replace(':', '-')}.ics`;
  return new File([lines.join('\r\n')], name, { type: 'text/calendar' });
}

function openCalendarFile(file = calendarFile()) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.type = 'text/calendar';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function appleCalendarFile() { openCalendarFile(); }

function googleCalendarUrl(event) {
  const url = new URL('https://calendar.google.com/calendar/render');
  url.searchParams.set('action', 'TEMPLATE');
  url.searchParams.set('text', event.title);
  url.searchParams.set('dates', `${event.start}/${event.end}`);
  url.searchParams.set('details', event.description);
  url.searchParams.set('location', event.location);
  return url.href;
}

function androidCalendarIntent(event) {
  return `intent://com.android.calendar/events#Intent;scheme=content;action=android.intent.action.INSERT;type=vnd.android.cursor.dir/event;S.title=${encodeURIComponent(event.title)};S.description=${encodeURIComponent(event.description)};S.eventLocation=${encodeURIComponent(event.location)};l.beginTime=${event.startMs};l.endTime=${event.endMs};S.browser_fallback_url=${encodeURIComponent(googleCalendarUrl(event))};end`;
}

function addToCalendar() {
  const dialog = $('#calendarDialog');
  if (!dialog || typeof dialog.showModal !== 'function') { appleCalendarFile(); return; }
  $('#addAndroidCalendar').href = androidCalendarIntent(calendarEvent());
  dialog.showModal();
}

document.addEventListener('click', event => {
  const date = event.target.closest('[data-manage-date]'); const time = event.target.closest('[data-manage-time]');
  if ((date || time) && mutationLocked()) return;
  if (date && !date.disabled) { state.date = date.dataset.manageDate; state.time = ''; renderDates(); renderTimes(); }
  if (time && !time.disabled) { if (!availableBusinessTimes(state.date, [time.dataset.manageTime]).length) { renderTimes(); return; } state.time = time.dataset.manageTime; renderTimes(); }
});
$('#openReschedule').addEventListener('click', openReschedule);
$('#closeReschedule').addEventListener('click', closeReschedule);
$('#confirmReschedule').addEventListener('click', confirmReschedule);
$('#cancelBooking').addEventListener('click', cancelBooking);
$('#confirmAttendance').addEventListener('click', confirmAttendance);
$('#managePaymentLink').addEventListener('click', event => {
  if (!event.currentTarget.dataset.paymentToken) return;
  event.preventDefault();
  void startOnlinePayment(event.currentTarget);
});
$('#addCalendar').addEventListener('click', addToCalendar);
$('#addAppleCalendar').addEventListener('click', () => { appleCalendarFile(); $('#calendarDialog').close(); });
$('#addAndroidCalendar').addEventListener('click', () => $('#calendarDialog').close());
$('#closeCalendarDialog').addEventListener('click', () => $('#calendarDialog').close());
$('#calendarDialog').addEventListener('click', event => { if (event.target === $('#calendarDialog')) $('#calendarDialog').close(); });
$('#retryManage').addEventListener('click', loadBooking);
$('#checkManageResult').addEventListener('click', checkManagementResult);
window.addEventListener('online', () => loadBooking({ silent: Boolean(state.booking) }));
document.addEventListener('visibilitychange', () => { if (!document.hidden && navigator.onLine) loadBooking({ silent: Boolean(state.booking) }); });
setInterval(() => { if (!document.hidden && navigator.onLine && state.booking) loadBooking({ silent: true }); }, 60000);
initializeManagement();
