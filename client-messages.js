(function initializeClientMessages(global) {
  'use strict';

  const core = global.MinutaMessagesCore;
  const providerUi = global.MinutaProviderMessages;
  const SESSION_KEY = 'minuta-client-session-v1';
  const CLIENT_RPC_MAP = Object.freeze({
    capability:'get_minuta_client_message_capability_v162',
    openConversation:'open_minuta_client_conversation_v162',
    listConversations:'list_minuta_client_conversations_v162',
    timeline:'get_minuta_client_message_timeline_v162',
    send:'send_minuta_client_message_v162',
    markRead:'mark_minuta_client_message_read_v162',
    prepareAction:'prepare_minuta_message_action_v162',
    applyAction:'apply_minuta_message_action_v162',
    openSupport:'open_minuta_client_support_v162'
  });

  const unwrap = value => Array.isArray(value) && value.length === 1 ? value[0] : value;
  const validSession = value => /^[0-9a-f]{64}$/i.test(String(value || '')) ? String(value) : '';
  const validBookingCode = value => {
    const result = String(value || '').trim();
    return result && result.length <= 80 ? result : '';
  };

  function loadSessionToken(storage = global.sessionStorage) {
    try { return validSession(storage.getItem(SESSION_KEY)); } catch { return ''; }
  }

  function formatActionSummary(summary) {
    if (!summary || typeof summary !== 'object') return '';
    const date = String(summary.target_date || '');
    const time = String(summary.target_time || '').slice(0, 5);
    const service = String(summary.service_name || 'Запись');
    const booking = String(summary.booking_code || '');
    return `${service}${booking ? ` · ${booking}` : ''}: перенести на ${date || 'указанную дату'}${time ? `, ${time}` : ''}. Изменение произойдёт только после подтверждения.`;
  }

  function createClientBridge({ db, sessionToken, bookingCode = '', rpcMap = {} }) {
    const token = validSession(sessionToken);
    if (!db || !token || !core || !providerUi) throw new Error('client_message_session_required');
    const map = Object.freeze({ ...CLIENT_RPC_MAP, ...rpcMap });
    const call = async (name, parameters) => {
      const result = await db.rpc(map[name], parameters);
      if (result?.error) throw Object.assign(new Error(result.error.message || `${map[name]}_failed`), result.error);
      return result?.data;
    };
    return Object.freeze({
      async capability() {
        const data = unwrap(await call('capability', { p_session_token:token, p_booking_code:validBookingCode(bookingCode) || null }));
        return { enabled:data?.client_chat_enabled === true, media_enabled:data?.media_enabled === true,
          transcription_enabled:data?.transcription_enabled === true, support_enabled:data?.support_enabled === true, reason:'' };
      },
      async listConversations({ beforeActivity = null, beforeId = null, query = '' } = {}) {
        return providerUi.normalizeConversationEnvelope(await call('listConversations', {
          p_session_token:token, p_before_activity:beforeActivity, p_before_id:beforeId,
          p_limit:50, p_query:String(query || '').slice(0, 120)
        }));
      },
      async openConversation({ bookingCode, requestId }) {
        const code = validBookingCode(bookingCode);
        if (!code) throw new Error('booking_code_required');
        return unwrap(await call('openConversation', { p_session_token:token, p_booking_code:code, p_request_id:requestId }));
      },
      async timeline({ conversationId, afterSequence = null, beforeSequence = null }) {
        return providerUi.normalizeTimelineEnvelope(await call('timeline', {
          p_session_token:token, p_conversation:conversationId, p_after_sequence:afterSequence,
          p_before_sequence:beforeSequence, p_limit:100
        }), conversationId);
      },
      async send({ conversation_id, client_request_id, body, author_kind = 'client' }) {
        const data = unwrap(await call('send', {
          p_session_token:token, p_conversation:conversation_id, p_request_id:client_request_id, p_body:body
        }));
        return core.normalizeMessage({ ...data, conversation_id, client_request_id, body, author_kind,
          entry_kind:'message', created_at:data?.sent_at || data?.created_at });
      },
      async lookup({ conversationId, requestId }) {
        const result = await this.timeline({ conversationId });
        return result.items.find(item => item.client_request_id === requestId) || null;
      },
      async markRead({ conversationId, sequence }) {
        return unwrap(await call('markRead', { p_session_token:token, p_conversation:conversationId, p_sequence:sequence }));
      },
      async prepareAction({ actionId, requestId }) {
        const data = unwrap(await call('prepareAction', { p_session_token:token, p_action:actionId, p_request_id:requestId }));
        return { ...data, booking_code:data?.summary?.booking_code || '', summary:formatActionSummary(data?.summary) };
      },
      async applyAction({ actionId, confirmationToken, requestId }) {
        const data = unwrap(await call('applyAction', {
          p_session_token:token, p_action:actionId, p_confirmation_token:confirmationToken, p_request_id:requestId
        }));
        return { ...data, applied:data?.status === 'applied', booking_code:data?.booking?.booking_code || '' };
      },
      async openSupport({ bookingCode, requestId, message, diagnostics, diagnosticsConsent }) {
        const code = validBookingCode(bookingCode);
        if (!code) throw new Error('support_booking_code_required');
        return unwrap(await call('openSupport', {
          p_session_token:token, p_booking_code:code, p_request_id:requestId, p_message:message,
          p_diagnostics:diagnosticsConsent ? Object.fromEntries((diagnostics || []).map(item => [item.key, item.value])) : {},
          p_diagnostics_consent:diagnosticsConsent === true
        }));
      }
    });
  }

  function applyTheme() {
    const catalog = global.MinutaThemeCatalog;
    if (!catalog) return;
    let key = catalog.settingsFromSearch(global.location.search).theme_key;
    try {
      const saved = JSON.parse(global.localStorage.getItem('minuta-client-active-presentation-v1') || 'null');
      if (saved?.theme && Date.now() - Number(saved.savedAt || 0) < 2592000000) key = saved.theme;
    } catch {}
    catalog.applyClientTheme(document.body, key);
  }

  function showAccess(root, message) {
    root.classList.add('message-center');
    root.innerHTML = `<section class="messages-page-access" aria-labelledby="messagesAccessTitle"><small>Личный раздел</small><h1 id="messagesAccessTitle">Сообщения</h1><p role="status">${message}</p><a href="my-bookings.html">Войти через «Мои записи»</a><a href="index.html">На главную</a></section>`;
  }

  async function mount(options = {}) {
    const root = options.root || document.querySelector('#clientMessagesRoot,[data-client-messages-root]');
    if (!root) return null;
    applyTheme();
    const sessionToken = validSession(options.sessionToken) || loadSessionToken(options.storage || global.sessionStorage);
    if (!sessionToken) { showAccess(root, 'Откройте личный раздел и подтвердите вход. Код записи и ссылки из адресной строки здесь не используются как ключ доступа.'); return null; }
    try {
      const bookingCode = validBookingCode(new URLSearchParams(global.location.search).get('booking'));
      const db = options.db || global.supabase.createClient(global.MINUTA_CONFIG.supabaseUrl, global.MINUTA_CONFIG.supabaseKey);
      const bridge = options.bridge || createClientBridge({ db, sessionToken, bookingCode });
      const controller = providerUi.createMessageCenter({ ...options, root, bridge, actorKind:'client',
        scope:'client-session', storage:options.storage || global.sessionStorage,
        bookingReturnUrl:'my-bookings.html', supportBookingCode:() => bookingCode,
        initialConversationId:new URLSearchParams(global.location.search).get('conversation') || '',
        diagnosticsPreview:() => [
          { key:'online', label:'Соединение', value:navigator.onLine },
          { key:'platform', label:'Экран', value:global.innerWidth <= 420 ? 'компактный' : global.innerWidth <= 800 ? 'средний' : 'широкий' },
          { key:'pwa_mode', label:'Приложение', value:global.matchMedia?.('(display-mode: standalone)').matches ? 'установлено' : 'браузер' }
        ]
      });
      await controller.initialize();
      if (bookingCode) {
        const opened = await bridge.openConversation({ bookingCode, requestId:core.createRequestId() }).catch(() => null);
        if (opened?.conversation_id) {
          await controller.reload();
          controller.select(opened.conversation_id);
        }
      }
      return controller;
    } catch {
      showAccess(root, navigator.onLine ? 'Сообщения пока недоступны. Ваши записи и вход не изменены.' : 'Нет соединения. Вернитесь после подключения — сообщения не отмечены как отправленные.');
      return null;
    }
  }

  global.MinutaClientMessages = Object.freeze({ RPC_MAP:CLIENT_RPC_MAP, SESSION_KEY, loadSessionToken, createClientBridge, mount });
  if (typeof document !== 'undefined' && document.querySelector('#clientMessagesRoot,[data-client-messages-root]')) void mount();
})(typeof window !== 'undefined' ? window : globalThis);
