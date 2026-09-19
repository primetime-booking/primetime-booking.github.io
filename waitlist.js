const db = window.supabase.createClient(window.MINUTA_CONFIG.supabaseUrl, window.MINUTA_CONFIG.supabaseKey);
const $ = selector => document.querySelector(selector);
const token = new URLSearchParams(location.search).get('token') || new URLSearchParams(location.hash.slice(1)).get('token') || '';
const organizationScope = new URLSearchParams(location.search).get('scope') === 'organization';
if (new URLSearchParams(location.search).has('token')) history.replaceState({}, '', `waitlist.html${organizationScope ? '?scope=organization' : ''}#token=${encodeURIComponent(token)}`);
applyStoredClientTheme();

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

function notify(message) { const toast = $('#toast'); toast.textContent = message; toast.hidden = false; clearTimeout(notify.timer); notify.timer = setTimeout(() => { toast.hidden = true; }, 2800); }
function localDate(value) { return new Date(`${value}T12:00:00`); }
function periodLabel(value) { return ({ any: 'Любое время', morning: 'Утро, 10:00–12:00', day: 'День, 12:00–17:00', evening: 'Вечер, 17:00–20:00' })[value] || 'Любое время'; }

function renderRequest(item) {
  const date = localDate(item.desired_date);
  const labels = { waiting: 'Ожидает', contacted: 'Мастер связался', booked: 'Запись создана', cancelled: 'Отменена', closed: 'Закрыта' };
  $('#waitlistManageService').textContent = item.service_name;
  $('#waitlistManagePerformer').textContent = [item.performer_name,item.location_name].filter(Boolean).join(' · ');
  if (organizationScope && item.organization_slug) {
    const bookingUrl = new URL('index.html',location.href);
    bookingUrl.searchParams.set('org',item.organization_slug);
    bookingUrl.searchParams.set('location',item.location_id);
    bookingUrl.searchParams.set('service',item.service_id);
    document.querySelectorAll('a[href="index.html"]').forEach(link => { link.href=bookingUrl.href; });
  }
  $('#waitlistManageCode').textContent = item.request_code;
  $('#waitlistManageStatus').textContent = labels[item.status] || item.status;
  $('#waitlistManageStatus').className = `manage-status status-${item.status}`;
  $('#waitlistManageDay').textContent = String(date.getDate());
  $('#waitlistManageMonth').textContent = date.toLocaleDateString('ru-RU', { month: 'short' }).replace('.', '');
  $('#waitlistManageDate').textContent = date.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('#waitlistManagePeriod').textContent = periodLabel(item.time_period);
  $('#cancelWaitlist').hidden = !['waiting', 'contacted'].includes(item.status);
}

async function loadRequest() {
  if (!/^[0-9a-f-]{36}$/i.test(token)) return showError();
  try {
    const { data, error } = await db.rpc(organizationScope ? 'get_minuta_waitlist_request_v111' : 'get_waitlist_request', { p_token: token });
    if (error) return showError(true);
    if (!data?.length) return showError();
    $('#waitlistManageLoading').hidden = true;
    $('#waitlistManageError').hidden = true;
    $('#waitlistManageContent').hidden = false;
    renderRequest(data[0]);
  } catch { showError(true); }
}

function showError(networkError = false) {
  $('#waitlistManageLoading').hidden = true;
  $('#waitlistManageContent').hidden = true;
  $('#waitlistManageError').hidden = false;
  $('#waitlistManageError h1').textContent = networkError ? 'Не удалось загрузить заявку' : 'Заявка не найдена';
  $('#waitlistManageError p').textContent = networkError
    ? 'Проверьте соединение и повторите попытку позже.'
    : 'Проверьте ссылку или выберите свободное время заново.';
}

$('#cancelWaitlist').addEventListener('click', async () => {
  if (!confirm('Отменить заявку в листе ожидания?')) return;
  const button = $('#cancelWaitlist'); button.disabled = true;
  try {
    const { error } = await db.rpc(organizationScope ? 'cancel_minuta_waitlist_request_v111' : 'cancel_waitlist_request', { p_token: token });
    if (error) throw error;
    notify('Заявка отменена');
    await loadRequest();
  } catch { notify('Не удалось отменить заявку. Проверьте соединение и попробуйте ещё раз.'); }
  finally { button.disabled = false; }
});

loadRequest();
