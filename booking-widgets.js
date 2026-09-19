(function () {
  'use strict';

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const SLUG = /^[a-z0-9][a-z0-9-]{2,62}$/;
  const TARGETS = Object.freeze(['general', 'service', 'provider', 'branch', 'group']);
  const MAP_SOURCES = Object.freeze({
    yandex:Object.freeze({ label:'Яндекс Карты', medium:'maps', campaign:'maps_booking' }),
    google:Object.freeze({ label:'Google Карты', medium:'maps', campaign:'maps_booking' })
  });

  function cleanId(value) { return UUID.test(String(value || '')) ? String(value) : ''; }
  function cleanSlug(value) { const next = String(value || '').trim().toLowerCase(); return SLUG.test(next) ? next : ''; }
  function cleanTarget(value) { return TARGETS.includes(value) ? value : 'general'; }
  function cleanSource(value) { const next = String(value || '').trim().toLowerCase(); return /^[a-z0-9_-]{2,40}$/.test(next) ? next : 'website'; }
  function html(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character]); }

  function readRequest(search = location.search) {
    const query = search instanceof URLSearchParams ? search : new URLSearchParams(search);
    return Object.freeze({
      serviceId:cleanId(query.get('service')),
      providerId:cleanId(query.get('provider')),
      branchId:cleanId(query.get('location')),
      groupId:cleanId(query.get('group')),
      embed:query.get('embed') === '1'
    });
  }

  function buildUrl(base, { slug, theme = '', headline = '', target = 'general', id = '', mode = 'link', source = 'website' } = {}) {
    const url = new URL(base, location.href);
    url.search = '';
    url.hash = '';
    const safeSlug = cleanSlug(slug);
    const safeTarget = cleanTarget(target);
    const safeId = cleanId(id);
    if (safeSlug) url.searchParams.set('org', safeSlug);
    if (theme) url.searchParams.set('theme', String(theme).slice(0, 40));
    if (headline) url.searchParams.set('headline', String(headline).slice(0, 40));
    const parameter = { service:'service', provider:'provider', branch:'location', group:'group' }[safeTarget];
    if (parameter && safeId) url.searchParams.set(parameter, safeId);
    const embed = mode === 'widget';
    const safeSource = cleanSource(source);
    const mapSource = MAP_SOURCES[safeSource];
    if (embed) url.searchParams.set('embed', '1');
    url.searchParams.set('utm_source', safeSource);
    url.searchParams.set('utm_medium', embed ? 'embed' : mapSource?.medium || 'shared_link');
    url.searchParams.set('utm_campaign', `${embed ? 'booking_widget' : mapSource?.campaign || 'booking_link'}_${safeTarget}${safeId ? `_${safeId}` : ''}`);
    url.searchParams.set('utm_content', safeId ? `${safeTarget}:${safeId}` : safeTarget);
    return url;
  }

  function embedCode(url, title = 'Онлайн-запись') {
    return `<iframe data-primetime-booking-widget src="${html(url.href)}" title="${html(title)}" loading="lazy" sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts" referrerpolicy="strict-origin-when-cross-origin" style="width:100%;height:720px;border:0;border-radius:20px" allow="clipboard-write"></iframe><script>(()=>{const f=document.currentScript.previousElementSibling;addEventListener('message',e=>{if(e.source!==f.contentWindow||e.data?.type!=='primetime:resize')return;const h=Math.max(420,Math.min(2400,Number(e.data.height)||720));f.style.height=h+'px'})})()</script>`;
  }

  function previewMarkup(title, detail) {
    return `<div><small>Онлайн-запись</small><h3>${html(title)}</h3><p>${html(detail || 'Клиент выберет подходящую услугу и время.')}</p><span>Перейти к записи</span></div>`;
  }

  function applyEmbedPresentation(request = readRequest()) {
    document.documentElement.classList.toggle('booking-embed', request.embed);
    if (request.embed) document.documentElement.dataset.bookingWidget = 'loading';
    return request.embed;
  }

  function startEmbedMessaging(request = readRequest()) {
    if (!request.embed || window.parent === window) return false;
    let parentOrigin = '';
    try { parentOrigin = document.referrer ? new URL(document.referrer).origin : ''; } catch {}
    if (!/^https?:\/\//.test(parentOrigin)) return false;
    let lastHeight = 0;
    const publish = () => {
      const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
      if (Math.abs(height - lastHeight) < 2) return;
      lastHeight = height;
      window.parent.postMessage({ type:'primetime:resize', height }, parentOrigin);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null;
    observer?.observe(document.documentElement);
    window.addEventListener('load', () => {
      document.documentElement.dataset.bookingWidget = 'ready';
      window.parent.postMessage({ type:'primetime:ready' }, parentOrigin);
      publish();
    }, { once:true });
    return true;
  }

  function createProviderController(options) {
    const { $, notify, getContext, getAppearance } = options;
    let context = null;
    let mode = 'link';
    let loading = false;

    function target() { return cleanTarget($('#bookingWidgetTarget')?.value); }
    function targetLabel(value) { return ({ general:'Общая запись', service:'Услуга', provider:'Специалист', branch:'Филиал', group:'Группа' })[value] || 'Общая запись'; }
    function sourceLabel(value) { return MAP_SOURCES[value]?.label || ''; }
    function choices(value) {
      if (!context) return [];
      if (value === 'service') return context.services.map(item => ({ id:item.id, label:item.name }));
      if (value === 'provider') {
        const map = new Map();
        context.services.forEach(item => { if (cleanId(item.performer_id)) map.set(item.performer_id, item.performer_profiles?.display_name || item.performer_name || 'Специалист'); });
        return [...map].map(([id,label]) => ({ id,label }));
      }
      if (value === 'branch') return context.locations.map(item => ({ id:item.id, label:item.name }));
      if (value === 'group') return context.groups.filter(item => Number(item.seats_left || 0) > 0).map(item => ({ id:item.id, label:`${item.title} · ${item.event_date}` }));
      return [];
    }

    function currentUrl() {
      const appearance = getAppearance?.() || {};
      return buildUrl(new URL('index.html', location.href), {
        slug:context?.organizationSlug,
        theme:appearance.theme_key,
        headline:appearance.headline_key,
        target:target(),
        id:$('#bookingWidgetItem')?.value,
        mode,
        source:$('#bookingWidgetSource')?.value
      });
    }

    function render() {
      const selector = $('#bookingWidgetItemField');
      const input = $('#bookingWidgetItem');
      const sourceInput = $('#bookingWidgetSource');
      const value = target();
      for (const option of sourceInput?.options || []) {
        if (MAP_SOURCES[option.value]) option.disabled = mode === 'widget';
      }
      if (mode === 'widget' && MAP_SOURCES[sourceInput?.value]) sourceInput.value = 'website';
      const items = choices(value);
      const selectedId = input?.value || '';
      if (selector) selector.hidden = value === 'general';
      if (input) {
        input.innerHTML = items.map(item => `<option value="${html(item.id)}">${html(item.label)}</option>`).join('');
        if (items.some(item => item.id === selectedId)) input.value = selectedId;
        input.disabled = !items.length;
      }
      const url = currentUrl();
      const output = $('#bookingWidgetOutput');
      const code = $('#bookingWidgetCode');
      const preview = $('#bookingWidgetPreview');
      const dialog = $('#bookingWidgetsDialog');
      if (dialog) dialog.dataset.mode = mode;
      if (output) output.value = url.href;
      if (code) code.value = embedCode(url, `${targetLabel(value)} — онлайн-запись`);
      if (preview) {
        if (mode === 'widget') {
          const selected = items.find(item => item.id === input?.value);
          preview.innerHTML = previewMarkup(targetLabel(value), selected?.label || 'Клиент выберет подходящую услугу и время.');
        } else preview.innerHTML = '';
      }
      document.querySelectorAll('[data-booking-widget-panel]').forEach(panel => { panel.hidden = panel.dataset.bookingWidgetPanel !== mode; });
      const ready = Boolean(context?.organizationSlug) && (value === 'general' || items.length > 0);
      document.querySelectorAll('[data-booking-widget-copy],#openBookingWidgetResult').forEach(control => { control.disabled = !ready; });
      const status = $('#bookingWidgetStatus');
      const mapLabel = mode === 'link' ? sourceLabel(sourceInput?.value) : '';
      if (status) status.textContent = ready
        ? mapLabel ? `Готово для ${mapLabel}. Добавьте эту ссылку как кнопку записи; конверсия будет видна в аналитике.` : 'Готово. Источник перехода будет виден в аналитике.'
        : value === 'general' ? 'Публичная запись для этой организации пока выключена.' : `Нет доступных вариантов: ${targetLabel(value).toLowerCase()}.`;
    }

    async function copy(value, success) {
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        notify?.(success);
      } catch {
        const field = document.createElement('textarea');
        field.value = value;
        field.style.position = 'fixed';
        field.style.opacity = '0';
        document.body.append(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        notify?.(copied ? success : 'Не удалось скопировать');
      }
    }

    async function open() {
      if (loading) return;
      loading = true;
      const button = $('#openBookingWidgets');
      if (button) button.disabled = true;
      try {
        context = await getContext();
        if (!Array.isArray(context.groups)) context.groups = [];
        render();
        $('#bookingWidgetsDialog')?.showModal();
      } catch {
        notify?.('Не удалось загрузить ссылки. Проверьте интернет и повторите.');
      } finally {
        loading = false;
        if (button) button.disabled = false;
      }
    }

    function bind() {
      $('#openBookingWidgets')?.addEventListener('click', open);
      $('#closeBookingWidgets')?.addEventListener('click', () => $('#bookingWidgetsDialog')?.close());
      $('#bookingWidgetTarget')?.addEventListener('change', render);
      $('#bookingWidgetItem')?.addEventListener('change', render);
      $('#bookingWidgetSource')?.addEventListener('change', render);
      document.querySelectorAll('[data-booking-widget-mode]').forEach(button => button.addEventListener('click', () => {
        mode = button.dataset.bookingWidgetMode === 'widget' ? 'widget' : 'link';
        document.querySelectorAll('[data-booking-widget-mode]').forEach(item => {
          const active = item.dataset.bookingWidgetMode === mode;
          item.classList.toggle('active', active);
          item.setAttribute('aria-pressed', String(active));
        });
        render();
      }));
      $('[data-booking-widget-copy="url"]')?.addEventListener('click', () => copy($('#bookingWidgetOutput')?.value, 'Ссылка скопирована'));
      $('[data-booking-widget-copy="code"]')?.addEventListener('click', () => copy($('#bookingWidgetCode')?.value, 'Код виджета скопирован'));
      $('#openBookingWidgetResult')?.addEventListener('click', () => window.open(currentUrl().href, '_blank', 'noopener,noreferrer'));
    }

    return { bind, open, render, buildUrl:currentUrl };
  }

  window.MinutaBookingWidgets = Object.freeze({ readRequest, buildUrl, embedCode, applyEmbedPresentation, startEmbedMessaging, createProviderController });
})();
