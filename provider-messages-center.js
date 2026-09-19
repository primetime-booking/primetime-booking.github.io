(function initializeProviderMessagesCenter(global) {
  'use strict';

  const core = global.MinutaMessagesCore;
  const PROVIDER_RPC_MAP = Object.freeze({
    capability:'get_minuta_message_capability_v162',
    setCapability:'set_minuta_message_center_settings_v162',
    openConversation:'open_minuta_provider_conversation_v162',
    listConversations:'list_minuta_provider_conversations_v162',
    timeline:'get_minuta_provider_message_timeline_v162',
    send:'send_minuta_provider_message_v162',
    markRead:'mark_minuta_provider_message_read_v162',
    proposeAction:'propose_minuta_message_action_v162',
    openSupport:'open_minuta_provider_support_v162'
  });

  const ACTION_LABELS = Object.freeze({
    propose_time:'Предложить другое время',
    send_address:'Отправить адрес',
    send_preparation:'Отправить подготовку',
    visit_context:'Показать маршрут визита'
  });

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
    })[character]);
  }

  function rows(value) {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.items)) return value.items;
    if (Array.isArray(value?.conversations)) return value.conversations;
    if (Array.isArray(value?.timeline)) return value.timeline;
    return [];
  }

  function unwrap(value) {
    return Array.isArray(value) && value.length === 1 ? value[0] : value;
  }

  function rpcError(result, name) {
    if (result?.error) throw Object.assign(new Error(result.error.message || `${name}_failed`), result.error);
    return result?.data;
  }

  function conversationFromRow(item) {
    return core.normalizeConversation({
      id:item?.conversation_id || item?.id,
      kind:item?.conversation_kind || item?.kind,
      title:item?.title || item?.counterparty_name || item?.client_name || (item?.kind === 'support' ? 'Поддержка PrimeTime' : 'Клиент'),
      subtitle:item?.subtitle || item?.booking_summary || item?.service_name,
      preview:item?.last_message_preview || item?.last_preview || item?.preview,
      updated_at:item?.last_activity_at || item?.updated_at,
      unread_count:item?.unread_count ?? 0,
      booking:item?.booking || (item?.booking_code ? item : null),
      can_send:item?.can_send !== false && item?.state !== 'closed',
      archived:item?.archived === true
    });
  }

  function actionFromTimeline(item) {
    if (!item) return null;
    const kind = item.action_type || item.action?.action_type || item.action?.kind;
    return {
      id:item.action_id || item.id,
      kind,
      title:item.action_title || item.action?.title || item.action?.payload?.title,
      summary:item.action_summary || item.action?.summary || item.action?.payload?.summary || item.action?.payload?.body
        || (item.action?.payload?.target_date ? `Новое время: ${item.action.payload.target_date}, ${String(item.action.payload.target_time || '').slice(0, 5)}` : ''),
      confirm_label:item.confirm_label || item.action?.confirm_label,
      state:(item.action_state || item.action?.state) === 'proposed' ? 'available' : (item.action_state || item.action?.state)
    };
  }

  function messageFromRow(item) {
    const entryKind = item?.entry_kind || item?.item_type || item?.kind;
    const inferredKind = entryKind === 'message'
      ? (item?.action ? 'action' : item?.message_kind === 'voice' ? 'voice' : item?.message_kind === 'attachment' ? 'attachment' : 'human')
      : entryKind;
    const senderRole = String(item?.sender_role || '');
    const authorKind = item?.sender_kind || item?.actor_kind || item?.author_kind
      || (entryKind === 'system' ? 'system' : senderRole === 'client' ? 'client' : senderRole === 'support' ? 'support' : 'provider');
    return core.normalizeMessage({
      ...item,
      id:item?.message_id || item?.event_id || item?.id || (entryKind === 'system' ? `system:${item?.conversation_id || item?.conversation}:${item?.sequence}` : ''),
      conversation_id:item?.conversation_id || item?.conversation,
      kind:inferredKind,
      author_kind:authorKind,
      author_label:item?.sender_label || item?.actor_label || item?.author_label,
      body:item?.body || item?.event_text || item?.summary || item?.event_type,
      created_at:item?.created_at || item?.sent_at,
      action:actionFromTimeline(item),
      media:item?.media
    });
  }

  function normalizeConversationEnvelope(data) {
    const source = unwrap(data);
    const conversations = rows(source).map(conversationFromRow);
    if (conversations.some(item => !item)) throw new Error('conversation_response_invalid');
    return {
      items:conversations,
      next_cursor:source?.next_cursor || null,
      before_activity:source?.next_before_activity || null,
      before_id:source?.next_before_id || null
    };
  }

  function normalizeTimelineEnvelope(data, conversationId) {
    const source = unwrap(data);
    const messages = rows(source).map(item => messageFromRow({ ...item, conversation_id:conversationId }));
    if (messages.some(item => !item || item.conversation_id !== conversationId)) throw new Error('timeline_response_invalid');
    return {
      items:messages,
      before_sequence:source?.next_before_sequence || null,
      after_sequence:source?.last_sequence || messages.at(-1)?.sequence || 0
    };
  }

  function createProviderBridge({ db, organizationId, rpcMap = {} }) {
    if (!db || !core.identifier(organizationId)) throw new Error('provider_message_context_required');
    const map = Object.freeze({ ...PROVIDER_RPC_MAP, ...rpcMap });
    const call = async (name, parameters) => rpcError(await db.rpc(map[name], parameters), map[name]);
    return Object.freeze({
      async capability() {
        const data = unwrap(await call('capability', { p_organization:organizationId }));
        if (!data || String(data.organization_id || organizationId) !== organizationId) throw new Error('message_capability_invalid');
        return {
          enabled:data.enabled === true || data.client_chat_enabled === true,
          media_enabled:data.media_enabled === true,
          transcription_enabled:data.transcription_enabled === true,
          support_enabled:data.support_enabled === true,
          reason:String(data.reason || '')
        };
      },
      async setCapability({ enabled, supportEnabled = false }) {
        const data = unwrap(await call('setCapability', {
          p_organization:organizationId,
          p_client_chat_enabled:enabled === true,
          p_support_enabled:supportEnabled === true
        }));
        return {
          enabled:data?.enabled === true || data?.client_chat_enabled === true,
          media_enabled:data?.media_enabled === true,
          transcription_enabled:data?.transcription_enabled === true,
          support_enabled:data?.support_enabled === true,
          reason:String(data?.reason || '')
        };
      },
      async listConversations({ beforeActivity = null, beforeId = null, query = '' } = {}) {
        const data = await call('listConversations', {
          p_organization:organizationId,
          p_before_activity:beforeActivity,
          p_before_id:beforeId,
          p_limit:50,
          p_query:String(query || '').slice(0, 120)
        });
        return normalizeConversationEnvelope(data);
      },
      async openConversation({ bookingCode, requestId }) {
        const data = unwrap(await call('openConversation', {
          p_organization:organizationId,
          p_booking:String(bookingCode || ''),
          p_request_id:requestId
        }));
        return conversationFromRow(data);
      },
      async timeline({ conversationId, afterSequence = null, beforeSequence = null }) {
        const data = await call('timeline', {
          p_conversation:conversationId,
          p_after_sequence:afterSequence,
          p_before_sequence:beforeSequence,
          p_limit:100
        });
        return normalizeTimelineEnvelope(data, conversationId);
      },
      async send({ conversation_id, client_request_id, body, author_kind = 'provider' }) {
        const data = unwrap(await call('send', {
          p_conversation:conversation_id,
          p_request_id:client_request_id,
          p_body:body
        }));
        const message = messageFromRow({ ...data, body, client_request_id, author_kind, entry_kind:'message' });
        if (!message) throw new Error('message_ack_unconfirmed');
        return message;
      },
      async lookup({ conversationId, requestId }) {
        const timeline = await this.timeline({ conversationId, afterSequence:null, beforeSequence:null });
        return timeline.items.find(item => item.client_request_id === requestId) || null;
      },
      async markRead({ conversationId, sequence }) {
        return unwrap(await call('markRead', { p_conversation:conversationId, p_sequence:sequence }));
      },
      async proposeAction({ conversationId, bookingCode, requestId, actionType, payload }) {
        return unwrap(await call('proposeAction', {
          p_conversation:conversationId,
          p_booking:String(bookingCode || ''),
          p_request_id:requestId,
          p_action_type:actionType,
          p_payload:payload || {}
        }));
      },
      async openSupport({ requestId, message, diagnostics, diagnosticsConsent }) {
        const data = unwrap(await call('openSupport', {
          p_organization:organizationId,
          p_request_id:requestId,
          p_message:message,
          p_diagnostics:diagnosticsConsent ? Object.fromEntries((diagnostics || []).map(item => [item.key, item.value])) : {},
          p_diagnostics_consent:diagnosticsConsent === true
        }));
        return conversationFromRow(data) || data;
      }
    });
  }

  function formatMoment(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleString('ru-RU', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
  }

  function initials(value) {
    const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
    return (parts.slice(0, 2).map(part => part[0]).join('') || 'С').toUpperCase();
  }

  function statusLabel(item) {
    if (!item.local) return item.read_at ? 'прочитано' : '';
    return ({
      'queued-offline':'ждёт интернет', sending:'отправляется', checking:'проверяем отправку',
      sent:'отправлено', failed:item.lost_ack ? 'результат не подтверждён' : 'не отправлено'
    })[item.status] || '';
  }

  function actorSide(item, actorKind) {
    if (item.author_kind === 'system') return 'system';
    if (actorKind === 'client' && item.author_kind === 'client') return 'client-self';
    return item.author_kind;
  }

  function messageMarkup(item, actorKind) {
    if (item.kind === 'system') {
      return `<li class="message-center-entry message-center-system" role="note"><div class="message-center-system-line"><strong>${escapeHtml(item.body)}</strong>${item.author_label ? ` · ${escapeHtml(item.author_label)}` : ''} · ${escapeHtml(formatMoment(item.created_at))}</div></li>`;
    }
    if (item.kind === 'action' && item.action) {
      const requiresConfirmation = item.action.kind === 'propose_time';
      const actionable = requiresConfirmation && item.action.state === 'available';
      const footer = requiresConfirmation
        ? `<button type="button" data-message-action="${escapeHtml(item.action.id)}" ${actionable ? '' : 'disabled'}>${escapeHtml(actionable ? item.action.confirm_label : item.action.state === 'applied' ? 'Выполнено' : 'Недоступно')}</button>`
        : '<span class="message-center-action-note">Информация по записи</span>';
      return `<li class="message-center-entry" data-author="${escapeHtml(actorSide(item, actorKind))}"><article class="message-center-action-card"><small>Действие по записи</small><strong>${escapeHtml(item.action.title || ACTION_LABELS[item.action.kind] || 'Предложение')}</strong><p>${escapeHtml(item.action.summary || item.body)}</p>${footer}</article></li>`;
    }
    const media = item.kind === 'voice' || item.kind === 'attachment';
    const transcript = item.media?.transcript_state === 'ready' && item.media.transcript
      ? `<details class="message-center-transcript"><summary>Расшифровка</summary><p>${escapeHtml(item.media.transcript)}</p></details>`
      : item.kind === 'voice' ? `<span class="message-center-media-status">${item.media?.transcript_state === 'failed' ? 'Расшифровка не удалась' : item.media?.transcript_state === 'processing' ? 'Расшифровка готовится' : 'Расшифровка недоступна'}</span>` : '';
    const retry = item.local && item.status === 'failed'
      ? `<button class="message-center-retry" type="button" data-message-retry="${escapeHtml(item.client_request_id)}">Повторить безопасно</button>` : '';
    return `<li class="message-center-entry" data-author="${escapeHtml(actorSide(item, actorKind))}"><article class="message-center-bubble">${media ? `<div class="message-center-media"><strong>${escapeHtml(item.media?.label || (item.kind === 'voice' ? 'Голосовое сообщение' : 'Вложение'))}</strong>${item.body ? `<p>${escapeHtml(item.body)}</p>` : ''}${transcript}</div>` : `<p>${escapeHtml(item.body)}</p>`}<div class="message-center-message-meta"><time datetime="${escapeHtml(item.created_at)}">${escapeHtml(formatMoment(item.created_at))}</time><span class="message-center-message-status" data-status="${escapeHtml(item.status)}">${escapeHtml(statusLabel(item))}</span></div>${retry}</article></li>`;
  }

  function createMessageCenter(options) {
    const root = options.root;
    const bridge = options.bridge;
    const actorKind = options.actorKind === 'client' ? 'client' : 'provider';
    if (!root || !bridge || !core) throw new Error('message_center_contract_required');
    const scope = core.identifier(options.scope) || actorKind;
    const canManageSettings = actorKind === 'provider' && options.canManageSettings === true && typeof bridge.setCapability === 'function';
    const outbox = core.createOutbox({ storage:options.storage || global.sessionStorage, scope });
    let capability = { enabled:false, media_enabled:false, transcription_enabled:false, support_enabled:false };
    let conversations = [];
    let selectedId = core.identifier(options.initialConversationId);
    let messages = [];
    let afterSequence = 0;
    let loading = false;
    let destroyed = false;
    let query = '';
    let unreadOnly = false;
    let pollTimer = null;
    let lastDialogTrigger = null;
    let preparedAction = null;
    const callbacks = new Map();

    root.classList.add('message-center');
    root.innerHTML = `<section class="message-center-shell" aria-labelledby="messageCenterTitle">
      <header class="message-center-heading"><div class="message-center-heading-copy"><small class="message-center-eyebrow">${actorKind === 'provider' ? 'Связь с клиентами' : 'Личный раздел'}</small><h1 id="messageCenterTitle" tabindex="-1">Сообщения</h1><p>Переписка по записям и отдельная помощь PrimeTime.</p></div><span class="message-center-state" data-message-connection role="status" aria-live="polite">Проверяем доступ…</span></header>
      <div class="message-center-toolbar"><label class="message-center-search"><span class="sr-only">Поиск диалогов</span><svg aria-hidden="true"><use href="ui-icons.svg#icon-search"></use></svg><input type="search" maxlength="120" placeholder="Найти клиента или запись" data-message-search></label><label class="message-center-unread"><input type="checkbox" data-message-unread><span>Только непрочитанные</span></label></div>
      <div class="message-center-notice" data-message-notice hidden><div><strong data-message-notice-title></strong><span data-message-notice-text></span></div><div class="message-center-notice-actions"><button type="button" data-message-reload>Повторить</button><button class="message-center-enable" type="button" data-message-enable hidden>Включить сообщения</button></div></div>
      <div class="message-center-workspace" data-message-workspace data-mobile-pane="list">
        <aside class="message-center-conversations" aria-label="Диалоги"><div class="message-center-conversation-head"><strong>Диалоги</strong><span data-message-total>0</span></div><ul class="message-center-list" data-message-list></ul><div class="message-center-support-cta" data-message-support-cta hidden><p>Помощник сначала покажет безопасное решение. К человеку можно перейти явно.</p><button type="button" data-message-open-support>Поддержка PrimeTime</button></div></aside>
        <section class="message-center-thread" aria-labelledby="messageThreadTitle"><header class="message-center-thread-head"><button class="message-center-back" type="button" data-message-back aria-label="Назад к диалогам"><svg aria-hidden="true"><use href="ui-icons.svg#icon-arrow-left"></use></svg></button><div class="message-center-thread-title"><strong id="messageThreadTitle" tabindex="-1">Выберите диалог</strong><span data-message-thread-subtitle></span></div><a class="message-center-booking-link" data-message-booking-link href="my-bookings.html" hidden>Запись</a><details class="message-center-thread-actions" data-message-provider-actions hidden><summary>Действия</summary><div>${Object.entries(ACTION_LABELS).map(([key,label]) => `<button type="button" data-message-propose="${key}">${escapeHtml(label)}</button>`).join('')}</div></details></header>
          <ol class="message-center-timeline" data-message-timeline aria-live="polite" aria-busy="false"><li class="message-center-empty"><div><strong>Выберите диалог</strong><p>Здесь появится переписка и контекст записи.</p></div></li></ol>
          <form class="message-center-composer" data-message-composer hidden><div class="message-center-composer-row"><button class="message-center-media-button" type="button" disabled aria-describedby="messageMediaAvailability" title="Вложения пока недоступны"><span aria-hidden="true">＋</span><span class="sr-only">Добавить вложение — недоступно</span></button><label><span class="sr-only">Сообщение</span><textarea data-message-input rows="1" maxlength="4000" placeholder="Сообщение…"></textarea></label><button class="message-center-send" type="submit" aria-label="Отправить сообщение"><svg aria-hidden="true"><use href="ui-icons.svg#icon-arrow-right"></use></svg></button></div><small class="message-center-media-help" id="messageMediaAvailability" data-message-media-help>Вложения, голос и расшифровка пока недоступны.</small></form>
        </section>
      </div>
      <dialog class="message-center-dialog" data-message-confirm-dialog aria-labelledby="messageConfirmTitle"><form method="dialog" data-message-confirm-form><header class="message-center-dialog-head"><h2 id="messageConfirmTitle">Подтвердите действие</h2><button class="message-center-dialog-close" type="button" data-message-dialog-close aria-label="Закрыть">×</button></header><div class="message-center-dialog-body"><p data-message-confirm-summary></p><div data-message-proposed-time hidden><label>Дата<input type="date" data-message-action-date></label><label>Время<input type="time" data-message-action-time></label></div><div data-message-action-note hidden><label><span data-message-action-note-label>Текст для клиента</span><textarea maxlength="2000" rows="4" data-message-action-note-input></textarea></label></div><p class="message-center-dialog-error" data-message-confirm-error role="alert" hidden></p></div><footer class="message-center-dialog-actions"><button type="button" data-message-dialog-close>Отмена</button><button type="submit" data-message-confirm-submit>Подтвердить</button></footer></form></dialog>
      <dialog class="message-center-dialog" data-message-support-dialog aria-labelledby="messageSupportTitle"><form method="dialog" data-message-support-form><header class="message-center-dialog-head"><h2 id="messageSupportTitle">Поддержка PrimeTime</h2><button class="message-center-dialog-close" type="button" data-message-dialog-close aria-label="Закрыть">×</button></header><div class="message-center-dialog-body"><p>Опишите вопрос. Ничего не будет отправлено, пока вы не нажмёте «Передать человеку».</p><label>Сообщение<textarea maxlength="2000" required data-message-support-text></textarea></label><details class="message-center-diagnostics"><summary>Что можно приложить</summary><ul data-message-diagnostics></ul></details><label class="message-center-consent"><input type="checkbox" data-message-diagnostics-consent><span>Разрешаю приложить только перечисленную диагностику. Логи, секреты и персональные данные не отправляются.</span></label><p class="message-center-dialog-error" data-message-support-error role="alert" hidden></p></div><footer class="message-center-dialog-actions"><button type="button" data-message-dialog-close>Не отправлять</button><button type="submit">Передать человеку</button></footer></form></dialog>
      <dialog class="message-center-dialog" data-message-settings-dialog aria-labelledby="messageSettingsTitle"><form method="dialog" data-message-settings-form><header class="message-center-dialog-head"><h2 id="messageSettingsTitle">Включить сообщения</h2><button class="message-center-dialog-close" type="button" data-message-dialog-close aria-label="Закрыть">×</button></header><div class="message-center-dialog-body"><p>Клиенты с подтверждённым доступом к записи смогут писать вам в PrimeTime. Никаких сообщений автоматически отправлено не будет.</p><p>Поддержка, файлы, голос и расшифровка останутся выключены.</p><p class="message-center-dialog-error" data-message-settings-error role="alert" hidden></p></div><footer class="message-center-dialog-actions"><button type="button" data-message-dialog-close>Отмена</button><button type="submit" data-message-settings-submit>Включить</button></footer></form></dialog>
    </section>`;

    const find = selector => root.querySelector(selector);
    const listNode = find('[data-message-list]');
    const timelineNode = find('[data-message-timeline]');
    const workspace = find('[data-message-workspace]');
    const composer = find('[data-message-composer]');
    const input = find('[data-message-input]');

    function setConnection(state, label) {
      const node = find('[data-message-connection]');
      node.dataset.state = state;
      node.textContent = label;
    }

    function setNotice(title = '', body = '') {
      const node = find('[data-message-notice]');
      node.hidden = !title;
      find('[data-message-notice-title]').textContent = title;
      find('[data-message-notice-text]').textContent = body;
    }

    function visibleConversations() {
      return conversations.filter(item => (!unreadOnly || item.unread_count > 0)
        && (!query || `${item.title} ${item.subtitle} ${item.preview}`.toLocaleLowerCase('ru-RU').includes(query)));
    }

    function renderConversationList() {
      const items = visibleConversations();
      find('[data-message-total]').textContent = String(items.length);
      if (!items.length) {
        listNode.innerHTML = `<li class="message-center-empty"><div><strong>${query || unreadOnly ? 'Ничего не найдено' : 'Диалогов пока нет'}</strong><p>${query || unreadOnly ? 'Измените поиск или фильтр.' : 'Переписка появится после безопасного открытия диалога по записи.'}</p></div></li>`;
        return;
      }
      listNode.innerHTML = items.map(item => `<li><button type="button" data-message-conversation="${escapeHtml(item.id)}" aria-current="${item.id === selectedId}"><span class="message-center-avatar" aria-hidden="true">${escapeHtml(item.kind === 'support' ? 'PT' : initials(item.title))}</span><span class="message-center-list-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.preview || item.subtitle || 'Диалог открыт')}</span></span><span class="message-center-list-meta"><time datetime="${escapeHtml(item.updated_at)}">${escapeHtml(formatMoment(item.updated_at))}</time>${item.unread_count ? `<b class="message-center-unread-count" aria-label="Непрочитанных: ${item.unread_count}">${item.unread_count > 99 ? '99+' : item.unread_count}</b>` : ''}</span></button></li>`).join('');
    }

    function selectedConversation() {
      return conversations.find(item => item.id === selectedId) || null;
    }

    function renderTimeline({ preserveScroll = false } = {}) {
      const conversation = selectedConversation();
      const merged = core.mergeMessages(messages, outbox.list(selectedId));
      const previousBottom = timelineNode.scrollHeight - timelineNode.scrollTop;
      if (!conversation) {
        timelineNode.innerHTML = '<li class="message-center-empty"><div><strong>Выберите диалог</strong><p>Здесь появится переписка и контекст записи.</p></div></li>';
        return;
      }
      timelineNode.innerHTML = merged.length
        ? merged.map(item => messageMarkup(item, actorKind)).join('')
        : '<li class="message-center-empty"><div><strong>Начните разговор</strong><p>Сообщение появится только после подтверждения сервером.</p></div></li>';
      if (preserveScroll) timelineNode.scrollTop = Math.max(0, timelineNode.scrollHeight - previousBottom);
      else timelineNode.scrollTop = timelineNode.scrollHeight;
    }

    function renderThreadHeader() {
      const conversation = selectedConversation();
      find('#messageThreadTitle').textContent = conversation?.title || 'Выберите диалог';
      find('[data-message-thread-subtitle]').textContent = conversation?.subtitle || (conversation?.kind === 'support' ? 'Отдельный канал поддержки' : '');
      const bookingLink = find('[data-message-booking-link]');
      bookingLink.hidden = !conversation?.booking?.booking_code;
      if (!bookingLink.hidden) {
        const url = new URL(options.bookingReturnUrl || (actorKind === 'provider' ? 'provider.html?section=bookings' : 'my-bookings.html'), global.location?.href || 'https://example.invalid/');
        url.searchParams.set('booking', conversation.booking.booking_code);
        bookingLink.href = `${url.pathname}${url.search}`;
      }
      const actions = find('[data-message-provider-actions]');
      actions.hidden = actorKind !== 'provider' || !conversation?.booking || !conversation.can_send;
      composer.hidden = !conversation || !conversation.can_send || capability.enabled !== true;
      input.disabled = composer.hidden;
    }

    async function loadConversations({ keepSelection = true } = {}) {
      if (loading || destroyed) return false;
      loading = true;
      setConnection(navigator.onLine ? 'loading' : 'offline', navigator.onLine ? 'Обновляем…' : 'Нет сети');
      try {
        if (!navigator.onLine) throw new Error('offline');
        const response = await bridge.listConversations({ query:query.trim() });
        conversations = response.items;
        if (!keepSelection || !conversations.some(item => item.id === selectedId)) selectedId = conversations[0]?.id || '';
        renderConversationList();
        renderThreadHeader();
        setNotice();
        setConnection('online', 'Синхронизировано');
        find('[data-message-support-cta]').hidden = capability.support_enabled !== true;
        if (selectedId) await loadTimeline({ focus:false });
        return true;
      } catch (error) {
        const offline = !navigator.onLine || core.connectionFailure(error);
        setConnection(offline ? 'offline' : 'error', offline ? 'Нет сети' : 'Не удалось обновить');
        setNotice(offline ? 'Работаем без сети' : 'Сообщения временно недоступны', offline ? 'Черновик можно сохранить. Отправка продолжится после подключения.' : 'Другие разделы PrimeTime продолжают работать.');
        if (!conversations.length) listNode.innerHTML = `<li class="message-center-error"><div><strong>${offline ? 'Нет соединения' : 'Не удалось загрузить диалоги'}</strong><p>Повторите безопасно: сообщения не будут дублироваться.</p><button type="button" data-message-reload>Повторить</button></div></li>`;
        return false;
      } finally { loading = false; }
    }

    async function loadTimeline({ focus = false, incremental = false } = {}) {
      const conversation = selectedConversation();
      if (!conversation || destroyed || !navigator.onLine) { renderTimeline(); return false; }
      timelineNode.setAttribute('aria-busy', 'true');
      try {
        const response = await bridge.timeline({ conversationId:conversation.id, afterSequence:incremental ? afterSequence : null });
        messages = incremental ? core.mergeMessages([...messages, ...response.items]) : response.items;
        afterSequence = Math.max(afterSequence, response.after_sequence || messages.at(-1)?.sequence || 0);
        for (const entry of outbox.list(conversation.id)) {
          if (messages.some(item => item.client_request_id === entry.client_request_id)) outbox.acknowledge(entry.client_request_id);
        }
        renderTimeline({ preserveScroll:incremental });
        if (focus) find('#messageThreadTitle').focus({ preventScroll:true });
        const highest = messages.at(-1)?.sequence || 0;
        if (highest && conversation.unread_count) {
          void bridge.markRead({ conversationId:conversation.id, sequence:highest }).then(() => {
            conversations = conversations.map(item => item.id === conversation.id ? Object.freeze({ ...item, unread_count:0 }) : item);
            renderConversationList();
          }).catch(() => {});
        }
        return true;
      } catch {
        setNotice('Не удалось обновить диалог', 'Текст не потерян. Повторите после восстановления связи.');
        renderTimeline();
        return false;
      } finally { timelineNode.setAttribute('aria-busy', 'false'); }
    }

    async function deliver(entry) {
      const result = await core.sendOutboxEntry({
        entry,
        outbox,
        online:navigator.onLine,
        send:payload => bridge.send(payload),
        lookup:requestId => bridge.lookup({ conversationId:entry.conversation_id, requestId })
      });
      if (result?.id && !result.local) messages = core.mergeMessages([...messages, result]);
      renderTimeline();
      if (result?.status === 'failed') setNotice('Отправка не подтверждена', 'Проверьте связь и нажмите «Повторить безопасно»: используется тот же номер запроса.');
      else if (result?.id) setNotice();
      return result;
    }

    async function sendMessage(event) {
      event.preventDefault();
      const conversation = selectedConversation();
      const body = input.value.trim();
      if (!conversation?.can_send || !body) return;
      const entry = outbox.queue(conversation.id, body, actorKind, navigator.onLine);
      input.value = '';
      renderTimeline();
      await deliver(entry);
    }

    async function retryMessage(clientRequestId) {
      const entry = core.retryEntry(outbox, clientRequestId, navigator.onLine);
      if (!entry) return;
      renderTimeline();
      await deliver(entry);
    }

    function closeDialog(dialog) {
      if (dialog?.open) dialog.close();
      lastDialogTrigger?.focus?.();
      lastDialogTrigger = null;
    }

    async function prepareMessageAction(actionId, trigger) {
      if (actorKind !== 'client' || typeof bridge.prepareAction !== 'function') return;
      lastDialogTrigger = trigger;
      trigger.disabled = true;
      try {
        const prepared = await bridge.prepareAction({ actionId, requestId:core.createRequestId() });
        if (!prepared?.confirmation_token || !prepared?.summary) throw new Error('action_confirmation_unavailable');
        preparedAction = { ...prepared, actionId, requestId:core.createRequestId(), mode:'apply' };
        find('[data-message-confirm-summary]').textContent = prepared.summary;
        find('[data-message-confirm-submit]').textContent = prepared.confirm_label || 'Подтвердить изменение';
        find('[data-message-confirm-error]').hidden = true;
        find('[data-message-proposed-time]').hidden = true;
        find('[data-message-confirm-dialog]').showModal();
      } catch {
        setNotice('Действие сейчас недоступно', 'Запись могла измениться. Обновите диалог и проверьте актуальное состояние.');
        lastDialogTrigger = null;
      } finally { trigger.disabled = false; }
    }

    function openProposal(actionType, trigger) {
      const conversation = selectedConversation();
      if (actorKind !== 'provider' || !conversation?.booking || typeof bridge.proposeAction !== 'function') return;
      lastDialogTrigger = trigger;
      preparedAction = { mode:'propose', actionType, requestId:core.createRequestId() };
      find('[data-message-confirm-summary]').textContent = `${ACTION_LABELS[actionType]}. Карточка появится в диалоге только после подтверждения сервером.`;
      find('[data-message-confirm-submit]').textContent = 'Отправить предложение';
      find('[data-message-confirm-error]').hidden = true;
      find('[data-message-proposed-time]').hidden = actionType !== 'propose_time';
      find('[data-message-action-note]').hidden = actionType === 'propose_time';
      find('[data-message-action-date]').required = actionType === 'propose_time';
      find('[data-message-action-time]').required = actionType === 'propose_time';
      find('[data-message-action-note-input]').required = actionType !== 'propose_time';
      find('[data-message-action-note-input]').value = '';
      find('[data-message-action-note-label]').textContent = ({
        send_address:'Адрес и как найти вход',
        send_preparation:'Как подготовиться к визиту',
        visit_context:'Контекст визита для клиента'
      })[actionType] || 'Текст для клиента';
      find('[data-message-confirm-dialog]').showModal();
    }

    async function submitAction(event) {
      event.preventDefault();
      const submit = find('[data-message-confirm-submit]');
      const errorNode = find('[data-message-confirm-error]');
      const conversation = selectedConversation();
      if (!preparedAction || !conversation) return;
      submit.disabled = true;
      errorNode.hidden = true;
      try {
        if (preparedAction.mode === 'apply') {
          const result = await bridge.applyAction({
            actionId:preparedAction.actionId,
            confirmationToken:preparedAction.confirmation_token,
            requestId:preparedAction.requestId
          });
          if (result?.applied !== true) throw new Error(result?.error_code || 'action_not_applied');
        } else {
          const payload = preparedAction.actionType === 'propose_time' ? {
            target_date:find('[data-message-action-date]').value,
            target_time:find('[data-message-action-time]').value
          } : {
            title:ACTION_LABELS[preparedAction.actionType],
            body:find('[data-message-action-note-input]').value.trim()
          };
          const result = await bridge.proposeAction({
            conversationId:conversation.id,
            bookingCode:conversation.booking.booking_id,
            requestId:preparedAction.requestId,
            actionType:preparedAction.actionType,
            payload
          });
          if (!result?.action_id && !result?.id) throw new Error('proposal_not_confirmed');
        }
        closeDialog(find('[data-message-confirm-dialog]'));
        preparedAction = null;
        await loadTimeline({ incremental:true });
      } catch {
        errorNode.textContent = 'Сервер не применил действие. Обновите запись: время или доступность могли измениться.';
        errorNode.hidden = false;
      } finally { submit.disabled = false; }
    }

    function diagnosticsPreview() {
      const supplied = typeof options.diagnosticsPreview === 'function' ? options.diagnosticsPreview() : [];
      return Array.isArray(supplied) ? supplied.filter(item => item && item.label && item.value).slice(0, 8) : [];
    }

    function openSupport(trigger) {
      lastDialogTrigger = trigger;
      const preview = diagnosticsPreview();
      find('[data-message-diagnostics]').innerHTML = preview.length
        ? preview.map(item => `<li>${escapeHtml(item.label)}: ${escapeHtml(item.value)}</li>`).join('')
        : '<li>Диагностика не будет приложена</li>';
      find('[data-message-diagnostics-consent]').checked = false;
      find('[data-message-support-error]').hidden = true;
      find('[data-message-support-dialog]').showModal();
      setTimeout(() => find('[data-message-support-text]').focus(), 0);
    }

    async function submitSupport(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const message = find('[data-message-support-text]').value.trim();
      const consent = find('[data-message-diagnostics-consent]').checked;
      const errorNode = find('[data-message-support-error]');
      const submit = form.querySelector('button[type="submit"]');
      if (!message) return;
      submit.disabled = true;
      errorNode.hidden = true;
      try {
        const result = await bridge.openSupport({
          requestId:core.createRequestId(),
          message,
          diagnostics:diagnosticsPreview(),
          diagnosticsConsent:consent,
          bookingCode:selectedConversation()?.booking?.booking_code || (typeof options.supportBookingCode === 'function' ? options.supportBookingCode() : '')
        });
        if (!result) throw new Error('support_not_confirmed');
        closeDialog(find('[data-message-support-dialog]'));
        find('[data-message-support-text]').value = '';
        await loadConversations({ keepSelection:false });
      } catch {
        errorNode.textContent = navigator.onLine ? 'Обращение не подтверждено сервером. Ничего не было отмечено как отправленное.' : 'Нет соединения. Текст сохранён в поле; отправьте после подключения.';
        errorNode.hidden = false;
      } finally { submit.disabled = false; }
    }

    async function flushOutbox() {
      if (!navigator.onLine) return;
      for (const entry of outbox.list()) {
        if (entry.status === 'sending') continue;
        await deliver(core.retryEntry(outbox, entry.client_request_id, true));
      }
    }

    function schedulePoll() {
      clearTimeout(pollTimer);
      if (destroyed) return;
      pollTimer = setTimeout(async () => {
        if (!document.hidden && navigator.onLine && selectedId) await loadTimeline({ incremental:true });
        schedulePoll();
      }, 15000);
    }

    async function initialize() {
      try {
        capability = await bridge.capability();
      } catch (error) {
        capability = { enabled:false, support_enabled:false, reason:String(error?.message || '') };
      }
      const mediaHelp = find('[data-message-media-help]');
      mediaHelp.textContent = capability.media_enabled
        ? 'Сервер разрешил медиа, но загрузка в этом интерфейсе пока не включена.'
        : 'Вложения, голос и расшифровка пока недоступны.';
      if (!capability.enabled) {
        setConnection('error', 'Раздел пока выключен');
        setNotice('Сообщения ещё не подключены', capability.reason || 'Схема v162 или доступ организации не подтверждены. Остальные разделы работают.');
        listNode.innerHTML = '<li class="message-center-empty"><div><strong>Раздел пока недоступен</strong><p>Здесь не показаны тестовые собеседники или фиктивные статусы.</p></div></li>';
        find('[data-message-enable]').hidden = !canManageSettings;
        return false;
      }
      find('[data-message-enable]').hidden = true;
      await loadConversations();
      await flushOutbox();
      schedulePoll();
      return true;
    }

    function openSettingsActivation(trigger) {
      if (!canManageSettings || capability.enabled) return;
      lastDialogTrigger = trigger;
      find('[data-message-settings-error]').hidden = true;
      find('[data-message-settings-dialog]').showModal();
    }

    async function submitSettingsActivation(event) {
      event.preventDefault();
      if (!canManageSettings || capability.enabled) return;
      const submit = find('[data-message-settings-submit]');
      const errorNode = find('[data-message-settings-error]');
      submit.disabled = true;
      errorNode.hidden = true;
      try {
        const result = await bridge.setCapability({ enabled:true, supportEnabled:false });
        if (result?.enabled !== true || result?.support_enabled === true) throw new Error('message_activation_unconfirmed');
        capability = result;
        closeDialog(find('[data-message-settings-dialog]'));
        await initialize();
      } catch {
        errorNode.textContent = 'Сервер не подтвердил включение. Настройки не считаются изменёнными.';
        errorNode.hidden = false;
      } finally { submit.disabled = false; }
    }

    root.addEventListener('click', event => {
      const conversation = event.target.closest('[data-message-conversation]');
      if (conversation) {
        selectedId = conversation.dataset.messageConversation;
        messages = [];
        afterSequence = 0;
        workspace.dataset.mobilePane = 'thread';
        renderConversationList();
        renderThreadHeader();
        void loadTimeline({ focus:true });
        return;
      }
      const retry = event.target.closest('[data-message-retry]');
      if (retry) { void retryMessage(retry.dataset.messageRetry); return; }
      const action = event.target.closest('[data-message-action]');
      if (action) { void prepareMessageAction(action.dataset.messageAction, action); return; }
      const proposal = event.target.closest('[data-message-propose]');
      if (proposal) { openProposal(proposal.dataset.messagePropose, proposal); return; }
      const support = event.target.closest('[data-message-open-support]');
      if (support) { openSupport(support); return; }
      const enable = event.target.closest('[data-message-enable]');
      if (enable) { openSettingsActivation(enable); return; }
      if (event.target.closest('[data-message-reload]')) { void loadConversations(); return; }
      if (event.target.closest('[data-message-back]')) {
        workspace.dataset.mobilePane = 'list';
        [...listNode.querySelectorAll('[data-message-conversation]')].find(node => node.dataset.messageConversation === selectedId)?.focus();
        return;
      }
      const close = event.target.closest('[data-message-dialog-close]');
      if (close) closeDialog(close.closest('dialog'));
    });
    composer.addEventListener('submit', sendMessage);
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); composer.requestSubmit(); } });
    find('[data-message-confirm-form]').addEventListener('submit', submitAction);
    find('[data-message-support-form]').addEventListener('submit', submitSupport);
    find('[data-message-settings-form]').addEventListener('submit', submitSettingsActivation);
    find('[data-message-search]').addEventListener('input', event => {
      clearTimeout(callbacks.get('search'));
      query = event.target.value.trim().toLocaleLowerCase('ru-RU');
      renderConversationList();
      callbacks.set('search', setTimeout(() => { void loadConversations(); }, 300));
    });
    find('[data-message-unread]').addEventListener('change', event => { unreadOnly = event.target.checked; renderConversationList(); });
    const onlineHandler = () => { setConnection('loading', 'Восстанавливаем связь…'); void loadConversations().then(flushOutbox); };
    const offlineHandler = () => { setConnection('offline', 'Нет сети'); setNotice('Работаем без сети', 'Новое сообщение останется в очереди на этом устройстве до повторной отправки.'); };
    const sessionResetHandler = () => outbox.clear();
    global.addEventListener('online', onlineHandler);
    global.addEventListener('offline', offlineHandler);
    global.addEventListener('minuta:provider-session-reset', sessionResetHandler);

    return Object.freeze({
      initialize,
      reload:() => loadConversations(),
      async openBooking(bookingId) {
        if (actorKind !== 'provider' || !core.identifier(bookingId) || capability.enabled !== true) return false;
        const opened = await bridge.openConversation({ bookingCode:bookingId, requestId:core.createRequestId() });
        const conversationId = core.identifier(opened?.conversation_id || opened?.id);
        if (!conversationId) throw new Error('conversation_open_unconfirmed');
        await loadConversations({ keepSelection:false });
        return this.select(conversationId);
      },
      select:conversationId => {
        if (!conversations.some(item => item.id === conversationId)) return false;
        selectedId = conversationId; renderConversationList(); renderThreadHeader(); void loadTimeline({ focus:true }); return true;
      },
      destroy() {
        destroyed = true;
        clearTimeout(pollTimer);
        callbacks.forEach(clearTimeout);
        global.removeEventListener('online', onlineHandler);
        global.removeEventListener('offline', offlineHandler);
        global.removeEventListener('minuta:provider-session-reset', sessionResetHandler);
      },
      snapshot:() => ({ capability:{ ...capability }, conversationCount:conversations.length, selectedId, messageCount:messages.length, outbox:outbox.list() })
    });
  }

  async function mount(options = {}) {
    const root = options.root || document.querySelector('[data-provider-messages-root],#providerMessagesRoot');
    if (!root) return null;
    try {
      const bridge = options.bridge || createProviderBridge(options);
      const controller = createMessageCenter({
        ...options,
        root,
        bridge,
        actorKind:'provider',
        scope:`provider:${options.organizationId || 'unknown'}`,
        bookingReturnUrl:'provider.html?section=bookings'
      });
      await controller.initialize();
      return controller;
    } catch (error) {
      root.classList.add('message-center');
      root.innerHTML = '<div class="message-center-error"><div><strong>Сообщения пока недоступны</strong><p>Контекст организации или схема v162 не подтверждены. Остальные разделы продолжают работать.</p></div></div>';
      return null;
    }
  }

  global.MinutaProviderMessages = Object.freeze({
    RPC_MAP:PROVIDER_RPC_MAP,
    ACTION_LABELS,
    createProviderBridge,
    createMessageCenter,
    mount,
    normalizeConversationEnvelope,
    normalizeTimelineEnvelope
  });
})(typeof window !== 'undefined' ? window : globalThis);
