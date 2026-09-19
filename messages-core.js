(function initializeMinutaMessagesCore(global) {
  'use strict';

  const MESSAGE_KINDS = new Set(['human', 'system', 'action', 'voice', 'attachment']);
  const AUTHOR_KINDS = new Set(['provider', 'client', 'support', 'system']);
  const LOCAL_STATUSES = new Set(['queued-offline', 'sending', 'checking', 'sent', 'failed']);
  const SERVER_STATUSES = new Set(['sent', 'read']);

  function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function text(value, maximum = 4000) {
    return String(value ?? '').replace(/\r\n?/g, '\n').slice(0, maximum);
  }

  function identifier(value) {
    const normalized = String(value || '');
    return /^[0-9a-z][0-9a-z_.:-]{0,159}$/i.test(normalized) ? normalized : '';
  }

  function requestId(value) {
    const normalized = String(value || '').toLowerCase();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
      ? normalized : '';
  }

  function createRequestId(cryptoObject = global.crypto) {
    if (typeof cryptoObject?.randomUUID === 'function') return cryptoObject.randomUUID();
    const bytes = new Uint8Array(16);
    if (typeof cryptoObject?.getRandomValues !== 'function') throw new Error('secure_random_unavailable');
    cryptoObject.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function iso(value) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
  }

  function boundedInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
  }

  function normalizeBookingContext(value) {
    const item = record(value);
    if (!item) return null;
    const bookingCode = text(item.booking_code, 80).trim();
    if (!bookingCode) return null;
    return Object.freeze({
      booking_id:identifier(item.booking_id),
      booking_code:bookingCode,
      service_name:text(item.service_name, 160).trim(),
      performer_name:text(item.performer_name, 120).trim(),
      booking_date:/^\d{4}-\d{2}-\d{2}$/.test(String(item.booking_date || '')) ? String(item.booking_date) : '',
      booking_time:/^\d{2}:\d{2}/.test(String(item.booking_time || '')) ? String(item.booking_time).slice(0, 5) : '',
      status:text(item.status, 32).trim()
    });
  }

  function normalizeConversation(value) {
    const item = record(value);
    if (!item) return null;
    const id = identifier(item.id || item.conversation_id);
    const kind = item.kind === 'support' ? 'support' : item.kind === 'client' ? 'client' : '';
    const updatedAt = iso(item.updated_at || item.last_message_at);
    const unreadCount = boundedInteger(item.unread_count, 0, 9999);
    if (!id || !kind || !updatedAt || unreadCount === null) return null;
    return Object.freeze({
      id,
      kind,
      title:text(item.title, 120).trim() || (kind === 'support' ? 'Поддержка PrimeTime' : 'Клиент'),
      subtitle:text(item.subtitle, 220).trim(),
      preview:text(item.preview, 240).trim(),
      updated_at:updatedAt,
      unread_count:unreadCount,
      booking:normalizeBookingContext(item.booking),
      can_send:item.can_send === true,
      archived:item.archived === true
    });
  }

  function normalizeAction(value) {
    const item = record(value);
    if (!item) return null;
    const id = identifier(item.id || item.action_id);
    const kind = identifier(item.kind);
    if (!id || !kind) return null;
    const state = ['available', 'applied', 'expired', 'unavailable'].includes(item.state) ? item.state : 'unavailable';
    return Object.freeze({
      id,
      kind,
      title:text(item.title, 160).trim(),
      summary:text(item.summary, 360).trim(),
      confirm_label:text(item.confirm_label, 80).trim() || 'Подтвердить',
      state,
      requires_confirmation:true
    });
  }

  function normalizeMessage(value) {
    const item = record(value);
    if (!item) return null;
    const id = identifier(item.id || item.message_id);
    const clientRequestId = requestId(item.client_request_id);
    const conversationId = identifier(item.conversation_id);
    const sequence = boundedInteger(item.sequence, 1);
    const entryKind = String(item.entry_kind || '');
    const requestedKind = item.kind || (entryKind === 'system' ? 'system' : entryKind === 'action' ? 'action' : entryKind === 'voice' ? 'voice' : entryKind === 'attachment' ? 'attachment' : entryKind === 'message' ? 'human' : '');
    const kind = MESSAGE_KINDS.has(requestedKind) ? requestedKind : '';
    const requestedAuthor = item.author_kind || item.sender_kind || item.actor_kind || (kind === 'system' ? 'system' : '');
    const authorKind = AUTHOR_KINDS.has(requestedAuthor) ? requestedAuthor : '';
    const createdAt = iso(item.created_at);
    if (!id || !conversationId || sequence === null || !kind || !authorKind || !createdAt) return null;
    const status = SERVER_STATUSES.has(item.status) ? item.status : 'sent';
    return Object.freeze({
      id,
      client_request_id:clientRequestId,
      conversation_id:conversationId,
      sequence,
      kind,
      author_kind:authorKind,
      author_label:text(item.author_label, 80).trim(),
      body:text(item.body || item.event_text || item.summary),
      created_at:createdAt,
      status,
      read_at:iso(item.read_at),
      action:kind === 'action' ? normalizeAction(item.action) : null,
      media:kind === 'voice' || kind === 'attachment' ? Object.freeze({
        state:['ready', 'processing', 'unavailable', 'failed'].includes(item.media?.state) ? item.media.state : 'unavailable',
        label:text(item.media?.label, 160).trim(),
        duration_seconds:boundedInteger(item.media?.duration_seconds, 0, 86400),
        transcript:text(item.media?.transcript, 4000),
        transcript_state:['ready', 'processing', 'unavailable', 'failed'].includes(item.media?.transcript_state)
          ? item.media.transcript_state : 'unavailable'
      }) : null
    });
  }

  function normalizePage(value, expectedConversationId = '') {
    const envelope = Array.isArray(value) ? { items:value } : record(value);
    if (!envelope || !Array.isArray(envelope.items)) return null;
    const items = envelope.items.map(normalizeMessage);
    if (items.some(item => !item)) return null;
    if (expectedConversationId && items.some(item => item.conversation_id !== expectedConversationId)) return null;
    const uniqueIds = new Set(items.map(item => item.id));
    const uniqueSequences = new Set(items.map(item => `${item.conversation_id}:${item.sequence}`));
    if (uniqueIds.size !== items.length || uniqueSequences.size !== items.length) return null;
    const cursor = envelope.next_cursor == null ? null : identifier(envelope.next_cursor);
    if (envelope.next_cursor != null && !cursor) return null;
    return Object.freeze({ items:Object.freeze(items), next_cursor:cursor });
  }

  function localMessage(entry) {
    return Object.freeze({
      id:`local:${entry.client_request_id}`,
      client_request_id:entry.client_request_id,
      conversation_id:entry.conversation_id,
      sequence:Number.MAX_SAFE_INTEGER,
      kind:'human',
      author_kind:entry.author_kind,
      author_label:'',
      body:entry.body,
      created_at:entry.created_at,
      status:entry.status,
      read_at:'',
      action:null,
      media:null,
      local:true,
      error_code:entry.error_code || '',
      lost_ack:entry.lost_ack === true
    });
  }

  function mergeMessages(serverMessages, outboxEntries = []) {
    const byId = new Map();
    const byRequest = new Map();
    for (const raw of serverMessages || []) {
      const item = normalizeMessage(raw) || raw;
      if (!item?.id || !item?.conversation_id) continue;
      byId.set(item.id, item);
      if (item.client_request_id) byRequest.set(item.client_request_id, item);
    }
    for (const entry of outboxEntries || []) {
      if (!entry?.client_request_id || byRequest.has(entry.client_request_id)) continue;
      const item = localMessage(entry);
      byId.set(item.id, item);
    }
    return [...byId.values()].sort((left, right) => {
      const leftLocal = left.local === true;
      const rightLocal = right.local === true;
      if (leftLocal !== rightLocal) return leftLocal ? 1 : -1;
      if (!leftLocal && left.sequence !== right.sequence) return left.sequence - right.sequence;
      return String(left.created_at).localeCompare(String(right.created_at))
        || String(left.client_request_id || left.id).localeCompare(String(right.client_request_id || right.id));
    });
  }

  function safeStorage(storage) {
    return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function' ? storage : null;
  }

  function createOutbox(options = {}) {
    const storage = safeStorage(options.storage);
    const storageKey = `minuta-message-outbox-v1:${identifier(options.scope) || 'anonymous'}`;
    const now = typeof options.now === 'function' ? options.now : () => new Date();
    const uuid = typeof options.uuid === 'function' ? options.uuid : () => createRequestId();
    let entries = [];

    function persist() {
      if (!storage) return;
      try { storage.setItem(storageKey, JSON.stringify(entries)); } catch {}
    }

    function hydrate() {
      if (!storage) return [];
      try {
        const parsed = JSON.parse(storage.getItem(storageKey) || '[]');
        if (!Array.isArray(parsed)) return [];
        entries = parsed.map(item => {
          const conversationId = identifier(item?.conversation_id);
          const clientRequestId = requestId(item?.client_request_id);
          const status = LOCAL_STATUSES.has(item?.status) && item.status !== 'sent' ? item.status : 'failed';
          const createdAt = iso(item?.created_at);
          const body = text(item?.body).trim();
          if (!conversationId || !clientRequestId || !createdAt || !body) return null;
          return { conversation_id:conversationId, client_request_id:clientRequestId, author_kind:item.author_kind === 'provider' ? 'provider' : 'client', body, created_at:createdAt, status, error_code:text(item.error_code, 80), lost_ack:item.lost_ack === true };
        }).filter(Boolean).slice(-100);
        persist();
      } catch { entries = []; }
      return list();
    }

    function list(conversationId = '') {
      return entries.filter(item => !conversationId || item.conversation_id === conversationId).map(item => ({ ...item }));
    }

    function queue(conversationId, body, authorKind, online = true) {
      const normalizedConversation = identifier(conversationId);
      const normalizedBody = text(body).trim();
      if (!normalizedConversation || !normalizedBody) throw new Error('invalid_outgoing_message');
      const entry = {
        conversation_id:normalizedConversation,
        client_request_id:uuid(),
        author_kind:authorKind === 'provider' ? 'provider' : 'client',
        body:normalizedBody,
        created_at:now().toISOString(),
        status:online ? 'sending' : 'queued-offline',
        error_code:'',
        lost_ack:false
      };
      if (!requestId(entry.client_request_id)) throw new Error('invalid_request_id');
      entries.push(entry);
      entries = entries.slice(-100);
      persist();
      return { ...entry };
    }

    function update(clientRequestId, patch) {
      const index = entries.findIndex(item => item.client_request_id === clientRequestId);
      if (index < 0) return null;
      const nextStatus = patch.status || entries[index].status;
      if (!LOCAL_STATUSES.has(nextStatus)) throw new Error('invalid_outbox_status');
      entries[index] = { ...entries[index], ...patch, status:nextStatus };
      persist();
      return { ...entries[index] };
    }

    function acknowledge(clientRequestId) {
      entries = entries.filter(item => item.client_request_id !== clientRequestId);
      persist();
    }

    function clear() {
      entries = [];
      if (storage) try { storage.removeItem(storageKey); } catch {}
    }

    hydrate();
    return Object.freeze({ storageKey, list, queue, update, acknowledge, clear });
  }

  function connectionFailure(error) {
    return error?.name === 'AbortError' || error?.status === 0 || /fetch|network|offline|timeout|connection/i.test(String(error?.message || error || ''));
  }

  async function sendOutboxEntry({ entry, outbox, send, lookup, online = true }) {
    if (!entry || typeof send !== 'function' || !outbox) throw new Error('invalid_send_contract');
    if (!online) return outbox.update(entry.client_request_id, { status:'queued-offline', error_code:'offline', lost_ack:false });
    outbox.update(entry.client_request_id, { status:'sending', error_code:'', lost_ack:false });
    try {
      const response = await send({
        conversation_id:entry.conversation_id,
        client_request_id:entry.client_request_id,
        body:entry.body
      });
      const message = normalizeMessage(response?.message || response);
      if (!message || message.client_request_id !== entry.client_request_id || message.conversation_id !== entry.conversation_id)
        throw Object.assign(new Error('message_ack_unconfirmed'), { deterministic:true });
      outbox.acknowledge(entry.client_request_id);
      return message;
    } catch (error) {
      if (connectionFailure(error) && typeof lookup === 'function') {
        outbox.update(entry.client_request_id, { status:'checking', error_code:'ack_unknown', lost_ack:true });
        try {
          const recovered = normalizeMessage(await lookup(entry.client_request_id));
          if (recovered && recovered.client_request_id === entry.client_request_id && recovered.conversation_id === entry.conversation_id) {
            outbox.acknowledge(entry.client_request_id);
            return recovered;
          }
        } catch {}
      }
      return outbox.update(entry.client_request_id, {
        status:'failed',
        error_code:connectionFailure(error) ? 'ack_unknown' : 'send_rejected',
        lost_ack:connectionFailure(error)
      });
    }
  }

  function retryEntry(outbox, clientRequestId, online = true) {
    const entry = outbox.list().find(item => item.client_request_id === clientRequestId);
    if (!entry) return null;
    return outbox.update(clientRequestId, { status:online ? 'sending' : 'queued-offline', error_code:'', lost_ack:false });
  }

  const api = Object.freeze({
    MESSAGE_KINDS, AUTHOR_KINDS, LOCAL_STATUSES, identifier, requestId, createRequestId,
    normalizeBookingContext, normalizeConversation, normalizeAction, normalizeMessage, normalizePage,
    mergeMessages, createOutbox, connectionFailure, sendOutboxEntry, retryEntry
  });
  global.MinutaMessagesCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
