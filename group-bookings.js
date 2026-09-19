(function () {
  'use strict';

  function isMissingRpc(error, name) {
    const text = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''}`;
    return /PGRST202|42883/i.test(text) || new RegExp(`function\\s+[^\\n]*${name}[^\\n]*does not exist`, 'i').test(text);
  }

  async function callRpc(db, name, parameters) {
    try {
      return await db.rpc(name, parameters) || { error:new Error('empty_rpc_response') };
    } catch (error) {
      return { error:error || new Error('rpc_failed') };
    }
  }

  function localIso(date) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  }

  function requestId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }

  function durationLabel(value) {
    const minutes = Number(value || 0);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours ? `${hours} ч${rest ? ` ${rest} мин` : ''}` : `${rest} мин`;
  }

  function eventDateLabel(item) {
    const date = new Date(`${item.event_date}T12:00:00`);
    return `${date.toLocaleDateString('ru-RU', { day:'numeric', month:'long', weekday:'long' })}, ${String(item.start_time || '').slice(0,5)}`;
  }

  function createProviderController(options) {
    const { db, $, escapeHtml, notify, requireWrites, getCurrentUser, getSessionGeneration, sessionIsCurrent, applyWriteAvailability } = options;
    let organization = null;
    let payload = null;
    let available = null;
    let revision = 0;
    let bound = false;
    let scopeRevision = 0;
    let formRevision = 0;
    let pendingSave = null;
    const pendingActions = new Set();

    function scopeSnapshot() {
      return { organizationId:organization?.id, userId:getCurrentUser()?.id, generation:getSessionGeneration(), revision:scopeRevision };
    }

    function scopeIsCurrent(scope) {
      return Boolean(scope.organizationId && organization?.id === scope.organizationId && scope.revision === scopeRevision && sessionIsCurrent(scope.userId, scope.generation));
    }

    function invalidateForm() {
      formRevision += 1;
      pendingSave = null;
    }

    async function action(name, parameters, message) {
      if (!requireWrites() || !organization?.id || available !== 'ready') return;
      const scope = scopeSnapshot();
      const key = `${scope.revision}:${name}:${parameters.p_event || parameters.p_participant || ''}`;
      if (pendingActions.has(key)) return;
      pendingActions.add(key);
      const { error } = await callRpc(db, name, parameters);
      pendingActions.delete(key);
      if (!scopeIsCurrent(scope)) return;
      notify(message(error));
      await load();
    }

    function reset() {
      revision += 1;
      scopeRevision += 1;
      invalidateForm();
      $('#groupEventDialog')?.close();
      organization = null;
      payload = null;
      available = null;
      render();
    }

    function setOrganization(next) {
      const changed = next?.id !== organization?.id;
      organization = next || null;
      if (!organization) return reset();
      if (changed) {
        scopeRevision += 1;
        invalidateForm();
        $('#groupEventDialog')?.close();
        payload = null;
        available = null;
      }
      return load();
    }

    async function load() {
      const userId = getCurrentUser()?.id;
      const generation = getSessionGeneration();
      const currentRevision = ++revision;
      if (!userId || !organization?.id) return { ok:false, optional:true };
      available = 'loading';
      render();
      const start = new Date();
      start.setDate(start.getDate() - 30);
      const end = new Date();
      end.setDate(end.getDate() + 365);
      const scope = scopeSnapshot();
      const { data, error } = await callRpc(db, 'get_minuta_group_booking_admin', {
        p_organization:organization.id,
        p_start:localIso(start),
        p_end:localIso(end)
      });
      if (!sessionIsCurrent(userId, generation) || !scopeIsCurrent(scope) || currentRevision !== revision) return { ok:false, optional:true, stale:true };
      if (error) {
        available = isMissingRpc(error, 'get_minuta_group_booking_admin') ? 'unsupported' : 'error';
        payload = null;
        render();
        return { ok:false, optional:true, unsupported:available === 'unsupported' };
      }
      payload = data || {};
      available = 'ready';
      render();
      return { ok:true, optional:true };
    }

    function render() {
      const panel = $('#groupEventsPanel');
      const settings = $('#groupBookingSettingsCard');
      if (!panel || !settings) return;
      const supported = Boolean(organization && ['ready','loading','error'].includes(available));
      settings.hidden = !supported;
      if (!supported) { panel.hidden = true; return; }
      const enabled = payload?.enabled === true;
      panel.hidden = !enabled;
      const toggle = $('#groupBookingsEnabled');
      if (toggle) {
        toggle.checked = enabled;
        toggle.disabled = available !== 'ready' || organization.current_role !== 'owner';
      }
      const note = $('#groupBookingsSettingNote');
      if (note) note.textContent = available === 'loading'
        ? 'Проверяем доступность…'
        : available === 'error'
          ? 'Не удалось загрузить групповые события. Повторите обновление.'
          : enabled ? 'Функция включена. События можно создавать и публиковать для клиентов.' : 'Функция выключена. Блок групповых сеансов скрыт из расписания, сохранённые события не удалены.';
      const add = $('#newGroupEvent');
      if (add) add.disabled = available !== 'ready' || !payload?.performers?.length || !payload?.locations?.length;
      const list = $('#groupEventsList');
      if (available === 'loading') {
        list.innerHTML = '<div class="loading-state"><i></i><span>Загружаем групповые события…</span></div>';
        return;
      }
      if (available === 'error') {
        list.innerHTML = '<div class="provider-empty"><strong>Групповые события временно недоступны</strong><small>Обычные записи продолжают работать.</small></div>';
        return;
      }
      const events = Array.isArray(payload?.events) ? payload.events : [];
      list.innerHTML = events.length ? events.map(eventMarkup).join('') : '<div class="provider-empty"><strong>Групповых событий пока нет</strong><small>Создайте занятие, консультацию или другой сеанс с ограниченным числом мест.</small></div>';
      applyWriteAvailability?.();
    }

    function eventMarkup(item) {
      const participants = Array.isArray(item.participants) ? item.participants : [];
      const active = participants.filter(entry => entry.status !== 'cancelled');
      const statusLabel = ({ draft:'Черновик', published:'Опубликовано', closed:'Набор закрыт', cancelled:'Отменено' })[item.status] || item.status;
      return `<article class="group-event-card status-${escapeHtml(item.status)}">
        <div class="group-event-head"><div><small>${escapeHtml(eventDateLabel(item))}</small><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.performer_name)} · ${escapeHtml(item.location_name)} · ${escapeHtml(durationLabel(item.duration_minutes))}</p></div><span>${active.length}/${Number(item.capacity || 0)}</span></div>
        ${item.description ? `<p class="group-event-description">${escapeHtml(item.description)}</p>` : ''}
        <div class="group-event-actions"><span class="booking-status">${escapeHtml(statusLabel)}</span><button class="secondary-button" type="button" data-edit-group-event="${escapeHtml(item.id)}" data-group-booking-write>Изменить</button>${item.status === 'published' ? `<button class="secondary-button" type="button" data-group-event-status="closed" data-event-id="${escapeHtml(item.id)}" data-group-booking-write>Закрыть набор</button>` : item.status === 'draft' || item.status === 'closed' ? `<button class="secondary-button" type="button" data-group-event-status="published" data-event-id="${escapeHtml(item.id)}" data-group-booking-write>Опубликовать</button>` : ''}${item.status !== 'cancelled' ? `<button class="danger" type="button" data-group-event-status="cancelled" data-event-id="${escapeHtml(item.id)}" data-group-booking-write>Отменить</button>` : ''}</div>
        <details class="group-participants"><summary><span>Участники</span><strong>${participants.length}</strong></summary><div>${participants.length ? participants.map(participantMarkup).join('') : '<p class="group-participant-empty">Пока никто не записался.</p>'}</div></details>
      </article>`;
    }

    function participantMarkup(item) {
      const statusLabel = ({ confirmed:'Участвует', cancelled:'Отменён', attended:'Посетил', no_show:'Не пришёл' })[item.status] || item.status;
      return `<article class="group-participant status-${escapeHtml(item.status)}"><div><strong>${escapeHtml(item.name)}</strong><a href="tel:${escapeHtml(String(item.phone || '').replace(/[^+0-9]/g,''))}">${escapeHtml(item.phone)}</a>${item.comment ? `<p><b>Комментарий:</b> ${escapeHtml(item.comment)}</p>` : ''}<small>${escapeHtml(statusLabel)}</small></div><div>${item.status !== 'cancelled' ? `<button type="button" data-group-participant-status="attended" data-participant-id="${escapeHtml(item.id)}" data-group-booking-write>Посетил</button><button type="button" data-group-participant-status="no_show" data-participant-id="${escapeHtml(item.id)}" data-group-booking-write>Не пришёл</button><button type="button" data-group-participant-status="cancelled" data-participant-id="${escapeHtml(item.id)}" data-group-booking-write>Отменить</button>` : `<button type="button" data-group-participant-status="confirmed" data-participant-id="${escapeHtml(item.id)}" data-group-booking-write>Вернуть</button>`}</div></article>`;
    }

    function populateEventForm(item = null) {
      const form = $('#groupEventForm');
      if (!form || !payload) return;
      invalidateForm();
      form.reset();
      const submit = $('#groupEventForm button[type="submit"]');
      if (submit) submit.disabled = false;
      $('#groupEventId').value = item?.id || '';
      $('#groupEventDialogTitle').textContent = item ? 'Изменить событие' : 'Новое групповое событие';
      $('#groupEventLocation').innerHTML = (payload.locations || []).map(location => `<option value="${escapeHtml(location.id)}">${escapeHtml(location.name)}</option>`).join('');
      $('#groupEventPerformer').innerHTML = (payload.performers || []).map(performer => `<option value="${escapeHtml(performer.id)}">${escapeHtml(performer.name)}</option>`).join('');
      $('#groupEventTitle').value = item?.title || '';
      $('#groupEventDescription').value = item?.description || '';
      $('#groupEventLocation').value = item?.location_id || payload.locations?.[0]?.id || '';
      $('#groupEventPerformer').value = item?.performer_id || payload.performers?.[0]?.id || '';
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      $('#groupEventDate').min = localIso(new Date());
      $('#groupEventDate').value = item?.event_date || localIso(tomorrow);
      $('#groupEventTime').value = String(item?.start_time || '18:00').slice(0,5);
      $('#groupEventDuration').value = String(item?.duration_minutes || 60);
      $('#groupEventCapacity').value = String(item?.capacity || 6);
      $('#groupEventStatus').value = item?.status || (payload.enabled ? 'published' : 'draft');
      $('#groupEventError').hidden = true;
      $('#groupEventDialog').showModal();
    }

    async function saveEvent(event) {
      event.preventDefault();
      if (!requireWrites() || !organization?.id || available !== 'ready' || pendingSave) return;
      const scope = scopeSnapshot();
      const currentForm = formRevision;
      const token = {};
      pendingSave = token;
      const button = event.submitter || $('#groupEventForm button[type="submit"]');
      button.disabled = true;
      $('#groupEventError').hidden = true;
      const parameters = {
        p_organization:organization.id,
        p_event:$('#groupEventId').value || null,
        p_location:$('#groupEventLocation').value,
        p_performer:$('#groupEventPerformer').value,
        p_title:$('#groupEventTitle').value.trim(),
        p_description:$('#groupEventDescription').value.trim(),
        p_date:$('#groupEventDate').value,
        p_time:`${$('#groupEventTime').value}:00`,
        p_duration:Number($('#groupEventDuration').value),
        p_capacity:Number($('#groupEventCapacity').value),
        p_status:$('#groupEventStatus').value
      };
      const result = await callRpc(db, 'upsert_minuta_group_event', parameters);
      if (pendingSave === token) pendingSave = null;
      if (!scopeIsCurrent(scope) || currentForm !== formRevision) return;
      const error = result.error || (typeof result.data !== 'string' || !result.data.trim() ? new Error('unconfirmed_group_event_response') : null);
      button.disabled = false;
      applyWriteAvailability?.();
      if (error) {
        const text = `${error.message || ''} ${error.details || ''}`;
        const rejectionCodes = {
          invalid_group_event:'22023', group_event_must_be_future:'22023',
          group_event_location_unavailable:'23514', group_event_performer_unavailable:'23514', group_event_capacity_below_participants:'23514',
          foreign_group_event_denied:'42501', group_booking_management_denied:'42501',
          group_event_not_found:'P0001', group_event_conflicts_with_booking:'P0001', group_event_time_conflict:'P0001'
        };
        const definite = Object.prototype.hasOwnProperty.call(rejectionCodes, error.message) && rejectionCodes[error.message] === error.code;
        if (!parameters.p_event && !definite) {
          pendingSave = token;
          button.disabled = true;
          $('#groupEventError').textContent = 'Результат создания пока неизвестен. Обновляем список событий для проверки. Не создавайте событие повторно, пока не убедитесь, что оно не появилось в списке. Введённые данные сохранены в этой форме.';
          $('#groupEventError').hidden = false;
          await load();
          if (scopeIsCurrent(scope) && currentForm === formRevision) button.disabled = true;
          return;
        }
        $('#groupEventError').textContent = /conflict/i.test(text) ? 'В это время у специалиста уже есть запись или другое событие.' : /capacity_below/i.test(text) ? 'Вместимость меньше числа действующих участников.' : 'Не удалось сохранить событие.';
        $('#groupEventError').hidden = false;
        return;
      }
      $('#groupEventDialog').close();
      notify('Групповое событие сохранено');
      await load();
    }

    async function setEnabled(enabled) {
      if (!requireWrites()) return render();
      const existingEvents = Array.isArray(payload?.events) ? payload.events.filter(item => item.status !== 'cancelled') : [];
      if (!enabled && existingEvents.length && !window.confirm('В кабинете есть групповые сеансы. Они сохранятся, но блок будет скрыт из расписания, а новые клиенты не смогут записываться. Отключить функцию?')) {
        render();
        return;
      }
      return action('set_minuta_group_bookings_enabled', { p_organization:organization?.id, p_enabled:enabled }, error => error ? 'Не удалось изменить настройку групповых событий' : enabled ? 'Групповые сеансы включены' : 'Групповые сеансы скрыты');
    }

    async function setEventStatus(id, status) {
      return action('set_minuta_group_event_status', { p_organization:organization?.id, p_event:id, p_status:status }, error => error ? 'Не удалось изменить статус события' : 'Статус события обновлён');
    }

    async function setParticipantStatus(id, status) {
      return action('set_minuta_group_participant_status', { p_organization:organization?.id, p_participant:id, p_status:status }, error => error ? (/group_event_full/i.test(`${error.message || ''}`) ? 'В событии больше нет свободных мест' : 'Не удалось изменить участника') : 'Статус участника обновлён');
    }

    function bind() {
      if (bound) return;
      bound = true;
      $('#groupBookingsEnabled')?.addEventListener('change', event => setEnabled(event.target.checked));
      $('#newGroupEvent')?.addEventListener('click', () => populateEventForm());
      $('#groupEventForm')?.addEventListener('submit', saveEvent);
      $('#closeGroupEventDialog')?.addEventListener('click', () => { invalidateForm(); $('#groupEventDialog').close(); });
      $('#groupEventDialog')?.addEventListener('cancel', invalidateForm);
      $('#groupEventsPanel')?.addEventListener('click', event => {
        const edit = event.target.closest('[data-edit-group-event]');
        const eventStatus = event.target.closest('[data-group-event-status]');
        const participantStatus = event.target.closest('[data-group-participant-status]');
        if (edit) populateEventForm((payload?.events || []).find(item => item.id === edit.dataset.editGroupEvent));
        if (eventStatus) setEventStatus(eventStatus.dataset.eventId, eventStatus.dataset.groupEventStatus);
        if (participantStatus) setParticipantStatus(participantStatus.dataset.participantId, participantStatus.dataset.groupParticipantStatus);
      });
    }

    return { bind, load, reset, setOrganization, get availability() { return available; } };
  }

  function createPublicController(options) {
    const { db, $, escapeHtml, getSlug, notify, getRequestedEventId, onRequestedEventUnavailable } = options;
    let events = [];
    let selected = null;
    let available = null;
    let revision = 0;
    let formRevision = 0;
    let catalogSlug = null;
    let selectedSlug = null;
    let pendingSubmit = null;
    let submittedParameters = null;
    let resolvedBooking = false;
    let bound = false;

    function setBookingFields(readOnly, parameters = null) {
      for (const [selector, key] of [['#publicGroupClientName','p_client_name'], ['#publicGroupClientPhone','p_client_phone'], ['#publicGroupClientComment','p_comment']]) {
        const input = $(selector);
        if (!input) continue;
        input.readOnly = readOnly;
        if (parameters) input.value = parameters[key];
      }
    }

    function invalidateForm() {
      formRevision += 1;
      pendingSubmit = null;
      selected = null;
      selectedSlug = null;
      submittedParameters = null;
      resolvedBooking = false;
      setBookingFields(false);
    }

    async function load() {
      const slug = getSlug();
      const currentRevision = ++revision;
      const root = $('#publicGroupEvents');
      if (catalogSlug !== slug) {
        catalogSlug = slug;
        events = [];
        available = null;
        invalidateForm();
        $('#publicGroupBookingDialog')?.close();
        render();
      }
      if (!root || !slug) return;
      const start = new Date();
      const end = new Date();
      end.setDate(end.getDate() + 180);
      const { data, error } = await callRpc(db, 'get_public_minuta_group_events', { p_slug:slug, p_start:localIso(start), p_end:localIso(end) });
      if (currentRevision !== revision || slug !== getSlug()) return;
      const requestedEventId = getRequestedEventId?.() || '';
      if (error) {
        available = isMissingRpc(error, 'get_public_minuta_group_events') ? 'unsupported' : 'error';
        events = [];
        root.hidden = true;
        if (requestedEventId) onRequestedEventUnavailable?.(requestedEventId);
        return;
      }
      available = data?.enabled ? 'ready' : 'disabled';
      events = Array.isArray(data?.events) ? data.events : [];
      if (requestedEventId) {
        const requested = events.find(item => item.id === requestedEventId && Number(item.seats_left || 0) > 0);
        if (available !== 'ready' || !requested) {
          events = [];
          render();
          $('#publicGroupBookingDialog')?.close();
          onRequestedEventUnavailable?.(requestedEventId);
          return;
        }
        render();
        open(requestedEventId);
        return;
      }
      render();
    }

    function render() {
      const root = $('#publicGroupEvents');
      const list = $('#publicGroupEventsList');
      if (!root || !list || available !== 'ready' || !events.length) {
        if (root) root.hidden = true;
        return;
      }
      root.hidden = false;
      list.innerHTML = events.map(item => {
        const full = Number(item.seats_left || 0) <= 0;
        return `<article class="public-group-event${full ? ' is-full' : ''}"><div><small>${escapeHtml(eventDateLabel(item))}</small><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.performer_name)} · ${escapeHtml(item.location_name)}${item.location_address ? ` · ${escapeHtml(item.location_address)}` : ''}</p>${item.description ? `<span>${escapeHtml(item.description)}</span>` : ''}</div><div><strong>${full ? 'Мест нет' : `${Number(item.seats_left)} из ${Number(item.capacity)} мест свободно`}</strong><button class="primary" type="button" data-book-group-event="${escapeHtml(item.id)}" ${full ? 'disabled' : ''}>Записаться</button></div></article>`;
      }).join('');
    }

    function open(id) {
      if (catalogSlug !== getSlug() || available !== 'ready') return;
      invalidateForm();
      selected = events.find(item => item.id === id && Number(item.seats_left || 0) > 0) || null;
      if (!selected) {
        onRequestedEventUnavailable?.(id);
        return;
      }
      selectedSlug = catalogSlug;
      const form = $('#publicGroupBookingForm');
      form.reset();
      const submit = form.querySelector('button[type="submit"]');
      if (submit) submit.disabled = false;
      form.dataset.requestId = requestId();
      $('#publicGroupBookingTitle').textContent = selected.title;
      $('#publicGroupBookingSummary').textContent = `${eventDateLabel(selected)} · ${selected.performer_name} · ${selected.location_name}`;
      $('#publicGroupBookingError').hidden = true;
      $('#publicGroupBookingSuccess').hidden = true;
      form.hidden = false;
      $('#publicGroupBookingDialog').showModal();
    }

    async function submit(event) {
      event.preventDefault();
      if (!selected || selectedSlug !== getSlug() || pendingSubmit || resolvedBooking) return;
      const form = event.currentTarget;
      if (!submittedParameters && !form.checkValidity()) {
        form.reportValidity();
        return;
      }
      const button = event.submitter || form.querySelector('button[type="submit"]');
      const currentForm = formRevision;
      const slug = selectedSlug;
      const token = {};
      pendingSubmit = token;
      button.disabled = true;
      $('#publicGroupBookingError').hidden = true;
      if (!submittedParameters) submittedParameters = {
        p_request_id:form.dataset.requestId,
        p_event:selected.id,
        p_client_name:$('#publicGroupClientName').value.trim(),
        p_client_phone:$('#publicGroupClientPhone').value.trim(),
        p_comment:$('#publicGroupClientComment').value.trim()
      };
      setBookingFields(true, submittedParameters);
      const result = await callRpc(db, 'book_minuta_group_event', submittedParameters);
      if (pendingSubmit === token) pendingSubmit = null;
      if (currentForm !== formRevision || slug !== getSlug()) return;
      button.disabled = false;
      const data = result.data;
      const validResult = data && typeof data.participant_id === 'string' && data.participant_id.trim() && typeof data.booking_code === 'string' && data.booking_code.trim() && ['confirmed','cancelled','attended','no_show'].includes(data.status);
      const error = result.error || (!validResult ? new Error('unconfirmed_booking_response') : null);
      if (error) {
        const text = `${error.message || ''} ${error.details || ''}`;
        const rejectionCodes = { group_event_duplicate_participant:'23505', group_event_full:'P0001', group_event_started:'P0001', group_event_unavailable:'P0001', invalid_group_participant:'22023' };
        const definite = Object.prototype.hasOwnProperty.call(rejectionCodes, error.message) && rejectionCodes[error.message] === error.code;
        if (definite) { submittedParameters = null; setBookingFields(false); }
        $('#publicGroupBookingError').textContent = definite
          ? /duplicate/i.test(text) ? 'Этот номер уже записан на событие.' : /full/i.test(text) ? 'Свободные места только что закончились.' : /started|unavailable/i.test(text) ? 'Запись на это событие уже закрыта.' : 'Проверьте имя, телефон и комментарий.'
          : 'Ответ о записи не получен. Повторите проверку — отправим те же данные без дубля. Пока результат неизвестен, данные защищены от изменения.';
        $('#publicGroupBookingError').hidden = false;
        if (definite && /duplicate|full|started|unavailable/i.test(text)) await load();
        return;
      }
      resolvedBooking = true;
      if (data.status !== 'confirmed') {
        button.disabled = true;
        $('#publicGroupBookingError').textContent = data.status === 'cancelled'
          ? 'Это участие отменено. Чтобы записаться снова, закройте окно и выберите событие заново.'
          : data.status === 'attended' ? 'Посещение этого события уже отмечено мастером.' : 'Мастер отметил, что вы не пришли на это событие.';
        $('#publicGroupBookingError').hidden = false;
        await load();
        return;
      }
      form.hidden = true;
      $('#publicGroupBookingSuccess').innerHTML = `<strong>Вы записаны</strong><p>Код участия: <b>${escapeHtml(data?.booking_code || '')}</b>. Мастер увидит ваш комментарий.</p>`;
      $('#publicGroupBookingSuccess').hidden = false;
      notify?.('Участие подтверждено');
      await load();
    }

    function bind() {
      if (bound) return;
      bound = true;
      $('#publicGroupEventsList')?.addEventListener('click', event => {
        const button = event.target.closest('[data-book-group-event]');
        if (button) open(button.dataset.bookGroupEvent);
      });
      $('#publicGroupBookingForm')?.addEventListener('submit', submit);
      $('#closePublicGroupBooking')?.addEventListener('click', () => { invalidateForm(); $('#publicGroupBookingDialog').close(); });
      $('#publicGroupBookingDialog')?.addEventListener('cancel', invalidateForm);
    }

    return { bind, load };
  }

  window.MinutaGroupBookings = { createProviderController, createPublicController };
})();
