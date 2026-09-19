const db = window.supabase.createClient(window.MINUTA_CONFIG.supabaseUrl, window.MINUTA_CONFIG.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const telegramClientEndpoint = `${window.MINUTA_CONFIG.supabaseUrl}/functions/v1/telegram-client-notify`;
const yookassaPaymentEndpoint = `${window.MINUTA_CONFIG.supabaseUrl}/functions/v1/yookassa-create-payment`;
const state = { step: 1, services: [], serviceCards: new Map(), serviceId: '', performerId: '', locationId: '', locations: [], teamMode: false, resourceScheduling: false, branchShiftScheduling: false, groupBookingSafety: true, organization: null, clientPage: { theme_key:'sage', headline_key:'massage-time' }, date: '', time: '', hour: '', period: 'all', moreDates: false, availability: new Map(), availabilityServiceId: '', availabilityLocationId: '', loadingAvailability: false, availabilityError: false };
let servicesLoadRevision = 0;
let serviceDetailsTrigger = null;
let availabilityLoadRevision = 0;
const AVAILABILITY_REQUEST_TIMEOUT_MS = 10000;
let selectionValidationPending = false;
let selectionValidationBlocked = false;
let bookingResultUncertain = false;
let bookingSubmissionPending = false;
let bookingFormRevision = 0;
let waitlistContext = null;
let waitlistSubmissionPending = false;
const BOOKING_ATTEMPT_KEY = 'minuta-booking-attempt-v1';
const CLIENT_SESSION_KEY = 'minuta-client-session-v1';
const CLIENT_CONTACT_KEY = 'minuta-client-contact-v1';
const CLIENT_CONTACT_TTL = 90 * 24 * 60 * 60 * 1000;
const VISITOR_PRESENCE_KEY = 'minuta-visitor-presence-v1';
const VISITOR_SOURCE_KEY = 'minuta-visitor-source-v1';
const VISITOR_FIRST_SOURCE_KEY = 'minuta-visitor-first-source-v1';
const VISITOR_PRESENCE_OPT_OUT_KEY = 'minuta-visitor-presence-opt-out-v1';
const VISITOR_FIRST_SOURCE_TTL = 90 * 24 * 60 * 60 * 1000;
const bookingQuery = new URLSearchParams(location.search);
const bookingLinkRequest = window.MinutaBookingWidgets?.readRequest?.(bookingQuery) || {};
window.MinutaBookingWidgets?.applyEmbedPresentation?.(bookingLinkRequest);
window.MinutaBookingWidgets?.startEmbedMessaging?.(bookingLinkRequest);
const requestedServiceId = bookingLinkRequest.serviceId || (/^[0-9a-f-]{36}$/i.test(bookingQuery.get('service') || '') ? bookingQuery.get('service') : '');
const requestedLocationId = bookingLinkRequest.branchId || (/^[0-9a-f-]{36}$/i.test(bookingQuery.get('location') || '') ? bookingQuery.get('location') : '');
const requestedPerformerId = bookingLinkRequest.providerId || '';
const requestedGroupId = bookingLinkRequest.groupId || '';
const explicitLinkParameters = ['service','location','provider','group'].filter(key => bookingQuery.has(key));
const explicitOrganizationSlug = bookingQuery.get('org') || '';
const invalidOrganizationSlug = bookingQuery.has('org') && !/^[a-z0-9][a-z0-9-]{2,62}$/.test(explicitOrganizationSlug);
const invalidLinkParameter = invalidOrganizationSlug || explicitLinkParameters.some(key => !({ service:requestedServiceId, location:requestedLocationId, provider:requestedPerformerId, group:requestedGroupId })[key]);
const conflictingGroupLink = Boolean(requestedGroupId && (requestedServiceId || requestedLocationId || requestedPerformerId));
const organizationSlugFromQuery = bookingQuery.get('org') || '';
const organizationSlugFromConfig = window.MINUTA_CONFIG.defaultOrganizationSlug || '';
const requestedOrganizationSlug = bookingQuery.has('org')
  ? (/^[a-z0-9][a-z0-9-]{2,62}$/.test(organizationSlugFromQuery) ? organizationSlugFromQuery : '')
  : (/^[a-z0-9][a-z0-9-]{2,62}$/.test(organizationSlugFromConfig) ? organizationSlugFromConfig : '');
const isRepeatBooking = bookingQuery.get('repeat') === '1' && Boolean(requestedServiceId);
const isFreeSlotsLink = bookingQuery.get('utm_campaign') === 'free_slots' && Boolean(requestedServiceId);
let bookingAttempt = loadBookingAttempt();
let visitorRegistrationPromise = null;
let visitorHeartbeatTimer = null;
let visitorLastHeartbeatAt = 0;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function cleanVisitorSource(value, limit = 80) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function visitorSessionId() {
  const storageKey = `${VISITOR_PRESENCE_KEY}:${requestedOrganizationSlug || 'default'}`;
  try {
    const saved = sessionStorage.getItem(storageKey);
    if (/^[0-9a-f-]{36}$/i.test(saved || '')) return saved;
    const created = createRequestId();
    sessionStorage.setItem(storageKey, created);
    return created;
  } catch { return createRequestId(); }
}

function visitorPresenceAllowed() {
  try { return localStorage.getItem(VISITOR_PRESENCE_OPT_OUT_KEY) !== '1'; }
  catch { return true; }
}

function sourceTitle(value) {
  const key = cleanVisitorSource(value, 32).toLowerCase();
  return ({ telegram:'Telegram', whatsapp:'WhatsApp', vk:'ВКонтакте', yandex:'Яндекс', google:'Google', qr:'QR-код', master:'Ссылка мастера', direct:'Прямой переход' })[key] || cleanVisitorSource(value) || 'Источник скрыт';
}

function detectVisitorSource() {
  const storageKey = `${VISITOR_SOURCE_KEY}:${requestedOrganizationSlug || 'default'}`;
  const queryAttribution = {
    utmSource: cleanVisitorSource(bookingQuery.get('utm_source'), 80).toLowerCase(),
    utmMedium: cleanVisitorSource(bookingQuery.get('utm_medium'), 80).toLowerCase(),
    utmCampaign: cleanVisitorSource(bookingQuery.get('utm_campaign'), 120),
    utmContent: cleanVisitorSource(bookingQuery.get('utm_content'), 120),
    utmTerm: cleanVisitorSource(bookingQuery.get('utm_term'), 120)
  };
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (saved?.label && saved?.kind && !queryAttribution.utmSource) return saved;
  } catch {}
  const source = queryAttribution.utmSource;
  const medium = queryAttribution.utmMedium;
  const campaign = queryAttribution.utmCampaign;
  let result;
  if (source) {
    const kind = source === 'qr' || medium === 'offline' ? 'qr' : ['telegram','whatsapp'].includes(source) || medium === 'messenger' ? 'social' : source === 'vk' || medium === 'social' ? 'social' : ['yandex','google'].includes(source) || medium === 'search' ? 'search' : 'campaign';
    result = { kind, label:`${sourceTitle(source)}${campaign ? ` · ${campaign}` : ''}`, ...queryAttribution, referrerHost:'' };
  } else {
    let referrer = null;
    try { referrer = document.referrer ? new URL(document.referrer) : null; } catch {}
    if (referrer && referrer.hostname !== location.hostname) {
      const host = referrer.hostname.replace(/^www\./, '').slice(0, 80);
      const search = /(^|\.)(yandex\.|google\.)/i.test(host);
      const social = /(^|\.)(t\.me|telegram\.|vk\.|wa\.me|whatsapp\.)/i.test(host);
      result = { kind:search ? 'search' : social ? 'social' : 'referral', label:sourceTitle(search ? (/yandex/i.test(host) ? 'yandex' : 'google') : social ? (/vk/i.test(host) ? 'vk' : /whatsapp|wa\.me/i.test(host) ? 'whatsapp' : 'telegram') : host), ...queryAttribution, referrerHost:host };
    } else result = { kind:'direct', label:'Прямой переход или источник скрыт', ...queryAttribution, referrerHost:'' };
  }
  try { sessionStorage.setItem(storageKey, JSON.stringify(result)); } catch {}
  return result;
}

const funnelEventRequests = new Map();
function trackBookingFunnelEvent(eventName, { serviceId = '', manageToken = '' } = {}) {
  if (!requestedOrganizationSlug || !visitorPresenceAllowed() || !navigator.onLine) return Promise.resolve(false);
  const allowed = ['page_opened','service_selected','slots_viewed','details_started','booking_created'];
  if (!allowed.includes(eventName)) return Promise.resolve(false);
  const requestKey = `${eventName}:${serviceId}:${manageToken}`;
  if (funnelEventRequests.has(requestKey)) return funnelEventRequests.get(requestKey);
  const source = detectVisitorSource();
  const request = db.rpc('track_public_booking_funnel_event', {
    p_slug:requestedOrganizationSlug,
    p_session:visitorSessionId(),
    p_event:eventName,
    p_service:/^[0-9a-f-]{36}$/i.test(serviceId || '') ? serviceId : null,
    p_manage_token:/^[0-9a-f-]{36}$/i.test(manageToken || '') ? manageToken : null,
    p_source_kind:source.kind,
    p_utm_source:source.utmSource || null,
    p_utm_medium:source.utmMedium || null,
    p_utm_campaign:source.utmCampaign || null,
    p_utm_content:source.utmContent || null,
    p_utm_term:source.utmTerm || null,
    p_referrer_host:source.referrerHost || null
  }).then(result => !result.error && result.data === true).catch(() => false);
  funnelEventRequests.set(requestKey, request);
  return request;
}

function firstVisitorSource(current) {
  const storageKey = `${VISITOR_FIRST_SOURCE_KEY}:${requestedOrganizationSlug || 'default'}`;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    const savedAt = Number(saved?.savedAt || 0);
    if (saved?.label && Number.isFinite(savedAt) && Date.now() - savedAt <= VISITOR_FIRST_SOURCE_TTL) return cleanVisitorSource(saved.label);
    localStorage.removeItem(storageKey);
    localStorage.setItem(storageKey, JSON.stringify({ label:current.label, savedAt:Date.now() }));
  } catch {}
  return current.label;
}

function visitorPageName() {
  if ($('#success') && !$('#success').hidden) return 'success';
  return ({ 1:'services', 2:'date', 3:'details' })[state.step] || 'services';
}

function ensureVisitorHeartbeat() {
  if (visitorHeartbeatTimer) return;
  visitorHeartbeatTimer = setInterval(() => {
    if (!document.hidden && navigator.onLine) void registerBookingPageVisit();
  }, 30000);
}

function registerBookingPageVisit({ force = false } = {}) {
  if (!requestedOrganizationSlug || !visitorPresenceAllowed() || document.hidden || !navigator.onLine) return Promise.resolve(false);
  ensureVisitorHeartbeat();
  if (visitorRegistrationPromise) return visitorRegistrationPromise;
  if (!force && Date.now() - visitorLastHeartbeatAt < 20000) return Promise.resolve(false);
  const source = detectVisitorSource();
  const contact = loadClientContact();
  visitorLastHeartbeatAt = Date.now();
  visitorRegistrationPromise = db.rpc('upsert_public_booking_presence', {
    p_slug: requestedOrganizationSlug,
    p_session: visitorSessionId(),
    p_page: visitorPageName(),
    p_source_kind: source.kind,
    p_source_label: source.label,
    p_first_source_label: firstVisitorSource(source),
    p_client_name: contact?.name || null,
    p_client_phone: contact?.phone || null
  }).then(async result => {
    if (isMissingRpc(result.error, 'upsert_public_booking_presence')) {
      const fallback = await db.rpc('register_public_booking_visit', { p_slug:requestedOrganizationSlug });
      return !fallback.error && fallback.data === true;
    }
    return !result.error && result.data === true;
  }).catch(() => false).finally(() => { visitorRegistrationPromise = null; });
  return visitorRegistrationPromise;
}

function loadBookingAttempt() {
  try {
    const attempt = JSON.parse(sessionStorage.getItem(BOOKING_ATTEMPT_KEY) || 'null');
    if (/^[0-9a-f-]{36}$/i.test(attempt?.requestId) && /^[0-9a-f]{64}$/i.test(attempt?.fingerprint)) {
      bookingResultUncertain = true;
      return { requestId:attempt.requestId, fingerprint:attempt.fingerprint, scope:typeof attempt.scope === 'string' ? attempt.scope : undefined };
    }
  } catch {}
  return null;
}

function saveBookingAttempt(attempt) {
  // Persist identity only: never contacts, management tokens or full RPC parameters.
  try { sessionStorage.setItem(BOOKING_ATTEMPT_KEY, JSON.stringify({ requestId:attempt.requestId, fingerprint:attempt.fingerprint, scope:attempt.scope })); } catch {}
}

function bookingScopeKey() {
  return JSON.stringify([requestedOrganizationSlug, state.teamMode, state.organization?.id || '', state.serviceId, state.locationId, state.date, state.time]);
}
function lockBookingContacts(locked) {
  for (const selector of ['#clientName', '#clientPhone', '#bookingBenefitCode']) { const field = $(selector); if (field) field.readOnly = locked; }
}
function restoreBookingRequest() {
  const request = bookingAttempt?.request;
  if (!request || bookingAttempt.detached) return;
  $('#clientName').value = request.p_client_name;
  $('#clientPhone').value = request.p_client_phone;
  $('#bookingBenefitCode').value = request.p_benefit_code || '';
  if (request.p_benefit_code) $('.booking-benefit').open = true;
  state.serviceId = request.p_service;
  state.date = request.p_date;
  state.time = request.p_time.slice(0, 5);
  if (request.p_location) state.locationId = request.p_location;
}
function restorePersistedBookingSelection() {
  if (!bookingAttempt?.scope || bookingAttempt.detached) return false;
  try {
    const [slug, teamMode, organizationId, serviceId, locationId, date, time] = JSON.parse(bookingAttempt.scope);
    if (slug !== requestedOrganizationSlug || teamMode !== state.teamMode || organizationId !== (state.organization?.id || '')
      || !state.services.some(service => service.id === serviceId)
      || (teamMode && !state.locations.some(location => location.id === locationId))
      || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return false;
    state.serviceId = serviceId; state.locationId = locationId; state.date = date; state.time = time;
    if (!dates.some(item => item.iso === date)) {
      const value = new Date(`${date}T12:00:00`);
      if (Number.isNaN(value.getTime())) return false;
      dates.push({ iso:date, day:value.getDate(), weekday:value.toLocaleDateString('ru-RU', { weekday:'short' }), label:value.toLocaleDateString('ru-RU', { day:'numeric', month:'long' }) });
    }
    return true;
  } catch { return false; }
}
function bookingReplyIsValid(data) {
  return Array.isArray(data) && data.length === 1 && typeof data[0]?.booking_code === 'string' && data[0].booking_code.length > 0
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data[0].manage_token || '');
}
function bookingDefiniteRejection(error) {
  return error?.code === 'P0001' && ['request_id_required', 'invalid_booking_data', 'invalid_client_data',
    'service_unavailable', 'organization_unavailable', 'location_unavailable', 'slot_unavailable',
    'resource_unavailable', 'booking_buffer_conflict', 'invalid_benefit_code', 'benefits_disabled',
    'benefit_code_not_found', 'benefit_client_mismatch', 'benefit_not_available',
    'insufficient_certificate_balance', 'package_service_exhausted', 'visit_pass_not_applicable',
    'booking_already_has_benefit', 'booking_payment_already_started', 'benefit_request_conflict',
    'client_online_booking_blocked'].includes(error.message);
}

async function bookingFingerprint(service, name, phone, benefitCode) {
  const value = JSON.stringify([service.id, state.teamMode ? state.locationId : '', state.date, state.time, name.trim(), phone.replace(/\D/g, ''), String(benefitCode || '').trim().toUpperCase()]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function currentBookingAttempt(service, name, phone, benefitCode) {
  const scope = bookingScopeKey();
  const fingerprint = await bookingFingerprint(service, name, phone, benefitCode);
  if (scope !== bookingScopeKey()) throw new Error('stale_booking_selection');
  if (bookingAttempt && (bookingAttempt.fingerprint !== fingerprint || (bookingAttempt.scope && bookingAttempt.scope !== scope))) {
    throw new Error('booking_attempt_unresolved');
  }
  if (!bookingAttempt) {
    bookingAttempt = { requestId: createRequestId(), fingerprint, scope };
    saveBookingAttempt(bookingAttempt);
  }
  bookingAttempt.detached = false;
  return bookingAttempt;
}

function clearBookingAttempt() {
  bookingAttempt = null;
  bookingResultUncertain = false;
  lockBookingContacts(false);
  try { sessionStorage.removeItem(BOOKING_ATTEMPT_KEY); } catch {}
}

function saveClientContact(name, phone) {
  const contact = { name: name.trim().slice(0, 80), phone: formatPhone(phone), savedAt: Date.now() };
  if (contact.name.length < 2 || contact.phone.replace(/\D/g, '').length !== 11) return;
  try { localStorage.setItem(CLIENT_CONTACT_KEY, JSON.stringify(contact)); } catch {}
  void registerBookingPageVisit({ force:true });
}

function loadClientContact() {
  try {
    const contact = JSON.parse(localStorage.getItem(CLIENT_CONTACT_KEY) || 'null');
    if (!contact || Date.now() - Number(contact.savedAt || 0) > CLIENT_CONTACT_TTL || String(contact.name || '').trim().length < 2 || String(contact.phone || '').replace(/\D/g, '').length !== 11) {
      localStorage.removeItem(CLIENT_CONTACT_KEY);
      return null;
    }
    return { name: String(contact.name).trim().slice(0, 80), phone: formatPhone(String(contact.phone)) };
  } catch { return null; }
}

function restoreClientContact() {
  const contact = loadClientContact();
  if (!contact) return;
  $('#clientName').value = contact.name;
  $('#clientPhone').value = contact.phone;
}

function bookingInputChanged() {
  if (bookingAttempt?.request && !bookingAttempt.detached) restoreBookingRequest();
  else bookingFormRevision += 1;
  $('#formError').hidden = true;
  updateSubmitAvailability();
  if (!bookingResultUncertain) return;
  if (state.step === 3 && !selectionValidationBlocked) setSelectionValidationState('ready');
}

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
function createDates() {
  const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone:'UTC' });
  const full = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone:'UTC' });
  const first = new Date(`${businessClock().date}T12:00:00Z`);
  return Array.from({ length: 14 }, (_, index) => {
    const date = new Date(first); date.setUTCDate(date.getUTCDate() + index);
    return { iso: localIsoDate(date), day: date.getUTCDate(), weekday: weekday.format(date).replace('.', ''), label: full.format(date) };
  });
}

const dates = createDates();
state.date = dates[0].iso;
function money(value) { return `${new Intl.NumberFormat('ru-RU').format(value)} ₽`; }
function selectedService() { return state.services.find(item => item.id === state.serviceId); }
function locationEligibleServices() {
  if (!state.resourceScheduling || !state.teamMode) return state.services;
  return state.services.filter(item => Array.isArray(item.location_ids) && item.location_ids.includes(state.locationId));
}
function performerOptions() {
  const unique = new Map();
  locationEligibleServices().forEach(service => {
    if (!service.performer_id || unique.has(service.performer_id)) return;
    unique.set(service.performer_id, { id: service.performer_id, name: service.performer_profiles?.display_name || 'Специалист' });
  });
  return [...unique.values()];
}
function visibleServices() {
  return locationEligibleServices().filter(item => {
    if (state.performerId && item.performer_id !== state.performerId) return false;
    return true;
  });
}

function expandCompactAvailabilityRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(item => (Array.isArray(item?.booking_times) ? item.booking_times : []).map(time => ({
    booking_date:item.booking_date,
    booking_time:time
  })));
}

function availabilityRpc(name, parameters, signal) {
  const request = db.rpc(name, parameters);
  return signal && typeof request?.abortSignal === 'function' ? request.abortSignal(signal) : request;
}

async function loadPublicSlots(service, start, end, locationId = state.locationId, signal = null) {
  if (state.resourceScheduling) {
    const parameters = {
      p_slug: requestedOrganizationSlug,
      p_location: locationId,
      p_service: service.id,
      p_start: start,
      p_end: end
    };
    const compactResult = await availabilityRpc('get_public_minuta_available_slots_compact_v165', parameters, signal);
    if (!isMissingRpc(compactResult.error, 'get_public_minuta_available_slots_compact_v165')) {
      return compactResult.error ? compactResult : { ...compactResult, data:expandCompactAvailabilityRows(compactResult.data) };
    }
    const bufferedResult = await availabilityRpc('get_public_minuta_available_slots_v101', parameters, signal);
    if (!isMissingRpc(bufferedResult.error, 'get_public_minuta_available_slots_v101')) return bufferedResult;
    if (state.groupBookingSafety) {
      const safeResult = await availabilityRpc('get_public_minuta_available_slots_group_safe', parameters, signal);
      if (!isMissingRpc(safeResult.error, 'get_public_minuta_available_slots_group_safe')) return safeResult;
      state.groupBookingSafety = false;
    }
    if (state.branchShiftScheduling) {
      const result = await availabilityRpc('get_public_minuta_available_slots_v4', parameters, signal);
      if (!isMissingRpc(result.error, 'get_public_minuta_available_slots_v4')) return result;
      state.branchShiftScheduling = false;
    }
    return availabilityRpc('get_public_minuta_available_slots_v3', parameters, signal);
  }
  const parameters = { p_service:service.id, p_start:start, p_end:end, p_ignore_booking:null };
  const compactResult = await availabilityRpc('get_available_slots_compact_v165', parameters, signal);
  if (!isMissingRpc(compactResult.error, 'get_available_slots_compact_v165')) {
    return compactResult.error ? compactResult : { ...compactResult, data:expandCompactAvailabilityRows(compactResult.data) };
  }
  const bufferedResult = await availabilityRpc('get_available_slots_v101', parameters, signal);
  if (!isMissingRpc(bufferedResult.error, 'get_available_slots_v101')) return bufferedResult;
  return availabilityRpc('get_available_slots', parameters, signal);
}

function renderLocations() {
  const field = $('#locationFilter');
  const select = $('#locationSelect');
  if (!field || !select) return;
  if (!state.teamMode || !state.locations.length) {
    field.hidden = true;
    select.innerHTML = '';
    return;
  }
  if (!state.locations.some(item => item.id === state.locationId)) {
    state.locationId = state.locations.find(item => item.is_primary)?.id || state.locations[0]?.id || '';
  }
  select.innerHTML = state.locations.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === state.locationId ? 'selected' : ''}>${escapeHtml(item.name || 'Филиал')}${item.address ? ` · ${escapeHtml(item.address)}` : ''}</option>`).join('');
  field.hidden = state.locations.length < 2;
}
function selectedDate() { return dates.find(item => item.iso === state.date); }
function timeRange(time, duration) {
  const [hours, minutes] = String(time).split(':').map(Number);
  const end = hours * 60 + minutes + Number(duration || 0);
  return `${time}–${String(Math.floor(end / 60) % 24).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}
function durationLabel(duration) {
  const minutes = Number(duration || 0);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} мин`;
  const hourWord = hours === 1 ? 'час' : hours >= 2 && hours <= 4 ? 'часа' : 'часов';
  return rest ? `${hours} ч ${rest} мин` : `${hours} ${hourWord}`;
}
function setBookingStatus(kind, text) {
  const element = $('#bookingStatus');
  if (!element) return;
  element.className = `status status-${kind}`;
  element.querySelector('span').textContent = text;
}
function setSelectionValidationState(kind) {
  selectionValidationPending = kind === 'checking';
  selectionValidationBlocked = kind !== 'ready';
  const submit = $('#submitBooking');
  if (!submit) return;
  if (kind === 'ready') {
    setSubmitLabel(bookingResultUncertain ? 'Проверить результат' : 'Подтвердить запись');
  } else {
    setSubmitLabel(kind === 'checking' ? 'Проверяем выбранное время…' : 'Сначала обновите расписание');
  }
  updateSubmitAvailability();
}

function setSubmitLabel(text) {
  const submit = $('#submitBooking');
  if (!submit) return;
  const label = submit.querySelector('span');
  const icon = submit.querySelector('use');
  if (label) label.textContent = text;
  else submit.textContent = text;
  if (icon) icon.setAttribute('href', /провер|сохраня|обновите/i.test(text) ? 'ui-icons.svg#icon-clock' : 'ui-icons.svg#icon-check');
}

function contactFormIsComplete() {
  const name = $('#clientName')?.value.trim() || '';
  const phoneDigits = ($('#clientPhone')?.value || '').replace(/\D/g, '');
  return name.length >= 2 && phoneDigits.length === 11 && Boolean($('#dataConsent')?.checked);
}

function updateSubmitAvailability() {
  const submit = $('#submitBooking');
  if (!submit) return;
  submit.disabled = bookingSubmissionPending || (!bookingAttempt && (selectionValidationPending || selectionValidationBlocked)) || !contactFormIsComplete();
  const phone = $('#clientPhone');
  const hint = $('#phoneHint');
  if (!phone || !hint) return;
  const digits = phone.value.replace(/\D/g, '');
  const valid = digits.length === 11;
  phone.classList.toggle('input-valid', valid);
  phone.classList.toggle('input-incomplete', Boolean(digits.length) && !valid);
  hint.textContent = valid ? 'Номер заполнен' : 'Введите 10 цифр после +7';
  hint.classList.toggle('valid', valid);
}
function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function renderClientThemeOptions() {
  const holder = $('#clientThemeOptions');
  const catalog = window.MinutaThemeCatalog;
  if (!holder || !catalog) return;
  const selected = catalog.readClientOverride(state.organization?.id, requestedOrganizationSlug);
  const organizationTheme = catalog.theme(state.clientPage.theme_key);
  const preview = item => `linear-gradient(135deg,${item.palette.surface},${item.palette.accentSoft} 62%,${item.palette.accent})`;
  holder.innerHTML = `<label class="client-theme-option theme-follow"><input type="radio" name="clientTheme" value="follow" ${selected === 'follow' ? 'checked' : ''}><i aria-hidden="true"></i><span><strong>Как у организации</strong><small>${escapeHtml(organizationTheme.label)}</small></span></label>${catalog.clientThemes.map(item => `<label class="client-theme-option theme-${item.key}" style="--theme-preview:${preview(item)}"><input type="radio" name="clientTheme" value="${item.key}" ${selected === item.key ? 'checked' : ''}><i aria-hidden="true"></i><span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.description)}</small></span></label>`).join('')}`;
}
function applyClientPagePresentation(settings = null) {
  const catalog = window.MinutaThemeCatalog;
  if (!catalog) return;
  if (settings) state.clientPage = catalog.normalizeSettings(settings);
  else if (!state.organization) state.clientPage = catalog.settingsFromSearch(window.location.search);
  const selected = catalog.readClientOverride(state.organization?.id, requestedOrganizationSlug);
  const effectiveTheme = selected === 'follow' ? state.clientPage.theme_key : selected;
  const theme = catalog.applyClientTheme(document.body, effectiveTheme);
  try { localStorage.setItem('minuta-client-active-presentation-v1', JSON.stringify({ theme:theme.key, savedAt:Date.now() })); } catch {}
  const headline = catalog.headline(state.clientPage.headline_key);
  if ($('#clientHeroTitle')) $('#clientHeroTitle').textContent = headline.label;
  if ($('#clientThemeButtonLabel')) $('#clientThemeButtonLabel').textContent = theme.label;
  renderClientThemeOptions();
}
function isMissingRpc(error, name) {
  const text = `${error?.code || ''} ${error?.message || ''} ${error?.details || ''}`;
  return /(?:PGRST202|42883)/i.test(text) || new RegExp(`function\\s+[^\\n]*${name}[^\\n]*does not exist`, 'i').test(text);
}
function serviceName(value) { return value === 'Общий массаж задней поверхности' ? 'Массаж задней поверхности тела' : value; }

function serviceCardHasContent(card) {
  return Boolean(card && (card.short_description || card.important_note || card.photo_storage_path
    || (Array.isArray(card.highlights) && card.highlights.length) || Number(card.total_reviews) > 0));
}

function reviewCountLabel(value) {
  const count = Number(value || 0);
  const mod100 = count % 100;
  const mod10 = count % 10;
  const noun = mod100 >= 11 && mod100 <= 14 ? 'отзывов' : mod10 === 1 ? 'отзыв' : mod10 >= 2 && mod10 <= 4 ? 'отзыва' : 'отзывов';
  return `${count} ${noun}`;
}

async function loadServiceCards(revision) {
  const ids = state.services.map(item => item.id).filter(Boolean).slice(0, 100);
  state.serviceCards = new Map();
  if (!ids.length) return;
  let result;
  try { result = await db.rpc('get_public_service_cards_v159', { p_service_ids:ids }); }
  catch { return; }
  if (revision !== servicesLoadRevision || result.error) return;
  state.serviceCards = new Map((result.data || []).map(item => [item.service_id, item]));
  renderServices();
}

function rejectRequestedBookingLink(message = 'Эта ссылка больше недоступна.') {
  state.services = [];
  state.serviceId = '';
  state.performerId = '';
  state.time = '';
  setBookingStatus('error', 'Ссылка недоступна');
  const holder = $('#services');
  if (holder) holder.innerHTML = `<div class="empty-service"><strong>Не удалось открыть запись</strong><span>${escapeHtml(message)}</span></div>`;
  const groupRoot = $('#publicGroupEvents');
  if (groupRoot) groupRoot.hidden = true;
  const groupList = $('#publicGroupEventsList');
  if (groupList) groupList.innerHTML = '';
  $('#publicGroupBookingDialog')?.close();
  if ($('#toDate')) $('#toDate').disabled = true;
  return false;
}

async function loadServices() {
  const holder = $('#services');
  const revision = ++servicesLoadRevision;
  const previousServiceId = state.serviceId;
  const previousLocationId = state.locationId;
  if (state.step === 3) setSelectionValidationState('checking');
  setBookingStatus('checking', 'Проверяем расписание…');
  holder.innerHTML = '<div class="loading-state"><i></i><span>Загружаем услуги…</span></div>';
  let data;
  let error;
  state.teamMode = false;
  state.resourceScheduling = false;
  state.branchShiftScheduling = false;
  state.organization = null;
  state.locations = [];
  state.locationId = '';
  if (invalidLinkParameter || conflictingGroupLink) {
    rejectRequestedBookingLink('Проверьте адрес ссылки или попросите отправить новую.');
    return false;
  }
  if (requestedOrganizationSlug) {
    let catalogResult = await db.rpc('get_public_minuta_catalog_v5', { p_slug: requestedOrganizationSlug });
    let appearanceAwareCatalog = !catalogResult.error;
    let shiftAwareCatalog = !catalogResult.error;
    if (isMissingRpc(catalogResult.error, 'get_public_minuta_catalog_v5')) {
      catalogResult = await db.rpc('get_public_minuta_catalog_v4', { p_slug: requestedOrganizationSlug });
      appearanceAwareCatalog = false;
      shiftAwareCatalog = !catalogResult.error;
    }
    if (isMissingRpc(catalogResult.error, 'get_public_minuta_catalog_v4')) {
      catalogResult = await db.rpc('get_public_minuta_catalog_v3', { p_slug: requestedOrganizationSlug });
      shiftAwareCatalog = false;
    }
    let branchAwareCatalog = !catalogResult.error;
    let resourceAwareCatalog = !catalogResult.error && catalogResult.data?.resource_scheduling === true;
    if (isMissingRpc(catalogResult.error, 'get_public_minuta_catalog_v3')) {
      catalogResult = await db.rpc('get_public_minuta_catalog_v2', { p_slug: requestedOrganizationSlug });
      branchAwareCatalog = !catalogResult.error;
      resourceAwareCatalog = false;
    }
    if (isMissingRpc(catalogResult.error, 'get_public_minuta_catalog_v2')) {
      catalogResult = await db.rpc('get_public_minuta_catalog', { p_slug: requestedOrganizationSlug });
      branchAwareCatalog = false;
      resourceAwareCatalog = false;
    }
    if (!catalogResult.error) {
      state.organization = catalogResult.data?.organization || null;
      state.clientPage = window.MinutaThemeCatalog.normalizeSettings(appearanceAwareCatalog ? catalogResult.data?.client_page : window.MinutaThemeCatalog.settingsFromSearch(window.location.search));
      applyClientPagePresentation(state.clientPage);
      state.locations = branchAwareCatalog && Array.isArray(catalogResult.data?.locations) ? catalogResult.data.locations.filter(item => item?.id) : [];
      // Once the branch-aware catalog answers for an organization, fail closed:
      // an empty location list means booking is unavailable, never legacy fallback.
      state.teamMode = Boolean(state.organization && branchAwareCatalog);
      state.resourceScheduling = Boolean(state.teamMode && resourceAwareCatalog);
      state.branchShiftScheduling = Boolean(state.resourceScheduling && shiftAwareCatalog && catalogResult.data?.branch_shift_scheduling === true);
      if (state.locations.some(item => item.id === requestedLocationId)) state.locationId = requestedLocationId;
      else if (state.locations.some(item => item.id === previousLocationId)) state.locationId = previousLocationId;
      data = state.organization && Array.isArray(catalogResult.data?.services) ? catalogResult.data.services : [];
      error = null;
    } else if (/PGRST202|42883|get_public_minuta_catalog|function .* does not exist/i.test(`${catalogResult.error.code || ''} ${catalogResult.error.message || ''} ${catalogResult.error.details || ''}`)) {
      ({ data, error } = await db.from('services').select('id, performer_id, name, duration_minutes, price_rub, performer_profiles(display_name)').eq('active', true).order('created_at', { ascending: true }));
    } else {
      ({ data, error } = catalogResult);
    }
  } else {
    ({ data, error } = await db.from('services').select('id, performer_id, name, duration_minutes, price_rub, performer_profiles(display_name)').eq('active', true).order('created_at', { ascending: true }));
  }
  if (revision !== servicesLoadRevision) return;
  if (error) {
    if (state.step === 3) setSelectionValidationState('failed');
    setBookingStatus(navigator.onLine ? 'error' : 'offline', navigator.onLine ? 'Запись временно недоступна' : 'Нет соединения с интернетом');
    holder.innerHTML = '<div class="empty-service"><strong>Не удалось проверить расписание</strong><span>Запись не создана. Проверьте интернет и повторите попытку.</span><button class="service-details-button" type="button" id="retryServices">Повторить</button></div>';
    return false;
  }
  state.services = data || [];
  if (bookingQuery.has('org') && !state.organization) {
    rejectRequestedBookingLink('Организация не принимает запись по этой ссылке.');
    return false;
  }
  const requestedServiceCandidate = requestedServiceId ? state.services.find(item => item.id === requestedServiceId) : null;
  if (state.resourceScheduling && !requestedLocationId && (requestedServiceCandidate || requestedPerformerId)) {
    const scopedServices = requestedServiceCandidate ? [requestedServiceCandidate] : state.services.filter(item => item.performer_id === requestedPerformerId);
    const compatibleLocation = state.locations.find(location => scopedServices.some(service => Array.isArray(service.location_ids) && service.location_ids.includes(location.id)));
    if (compatibleLocation) state.locationId = compatibleLocation.id;
  }
  const requestedPerformerExists = !requestedPerformerId || state.services.some(item => item.performer_id === requestedPerformerId);
  const requestedLocationExists = !requestedLocationId || state.locations.some(item => item.id === requestedLocationId);
  const requestedServiceFitsLocation = !requestedServiceCandidate || !requestedLocationId || !Array.isArray(requestedServiceCandidate.location_ids) || requestedServiceCandidate.location_ids.includes(requestedLocationId);
  const requestedServiceFitsPerformer = !requestedServiceCandidate || !requestedPerformerId || requestedServiceCandidate.performer_id === requestedPerformerId;
  const requestedPerformerFitsLocation = !requestedPerformerId || !requestedLocationId || state.services.some(item => item.performer_id === requestedPerformerId && (!Array.isArray(item.location_ids) || item.location_ids.includes(requestedLocationId)));
  if ((requestedServiceId && !requestedServiceCandidate) || !requestedPerformerExists || !requestedLocationExists || !requestedServiceFitsLocation || !requestedServiceFitsPerformer || !requestedPerformerFitsLocation) {
    rejectRequestedBookingLink('Выбранная услуга, специалист или филиал недоступны для этой организации.');
    return false;
  }
  if (requestedPerformerId) state.performerId = requestedPerformerId;
  renderLocations();
  if (restorePersistedBookingSelection()) {
    // Restoration may select a non-primary branch after the initial render.
    renderLocations();
    renderSpecialists(); renderServices(); await showStep(3);
    showError('Есть незавершённая проверка записи. Укажите исходные контакты и нажмите «Проверить результат».');
    return true;
  }
  const requestedService = state.services.find(item => item.id === requestedServiceId);
  const performers = performerOptions();
  if ((isRepeatBooking || requestedServiceId) && requestedService) state.performerId = requestedPerformerId || requestedService.performer_id || '';
  if (state.performerId && !performers.some(item => item.id === state.performerId)) state.performerId = '';
  const selectionWasRemoved = Boolean(previousServiceId) && !state.services.some(item => item.id === previousServiceId);
  const locationServices = visibleServices();
  if (!previousServiceId) {
    state.serviceId = requestedServiceId
      ? (locationServices.some(item => item.id === requestedServiceId) ? requestedServiceId : '')
      : '';
    if (!state.serviceId && isFreeSlotsLink && locationServices.some(item => item.id === requestedServiceId)) state.serviceId = requestedServiceId;
  }
  else if (selectionWasRemoved) state.serviceId = '';
  else if (!locationServices.some(item => item.id === previousServiceId)) state.serviceId = '';
  setBookingStatus(locationServices.length ? 'open' : 'closed', locationServices.length ? 'Запись открыта' : 'В этом филиале пока нет доступных услуг');
  renderSpecialists();
  renderServices();
  void loadServiceCards(revision);
  if (state.organization) {
    void registerBookingPageVisit();
    void trackBookingFunnelEvent('page_opened');
  }
  if (state.teamMode && !state.locations.length) {
    setBookingStatus('error', 'Запись команды пока не активирована');
    $('#toDate').disabled = true;
  }
  if (selectionWasRemoved) {
    state.time = '';
    state.availability = new Map();
    setBookingStatus('error', 'Выбранная услуга больше недоступна');
    await showStep(1);
    return false;
  }
  if (requestedServiceId && state.step === 1 && selectedService()) await showStep(2);
  else if (state.step === 2) await loadAvailability();
  if (state.step === 3 && selectedService()) await validateCurrentSelection();
  return true;
}

function publicPortfolioAfterLabel(sessionCount) {
  const count = Number(sessionCount);
  if (!count) return 'После процедуры';
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'сеанса' : 'сеансов';
  return `После ${count} ${word}`;
}

function publicPortfolioPhoto(item, type) {
  return (item.portfolio_photos || []).find(photo => photo.photo_type === type);
}

function publicPortfolioPhotoMarkup(photo, label) {
  if (!photo?.signedUrl) return `<figure class="portfolio-photo portfolio-photo-empty"><span>${escapeHtml(label)}</span></figure>`;
  return `<figure class="portfolio-photo"><img src="${escapeHtml(photo.signedUrl)}" alt="${escapeHtml(photo.alt_text || label)}" loading="lazy" decoding="async"><span>${escapeHtml(label)}</span></figure>`;
}

async function loadPublicPortfolio() {
  const section = $('#portfolioSection');
  const holder = $('#publicPortfolioList');
  if (!section || !holder) return;
  const { data, error } = await db.from('portfolio_items')
    .select('id, procedure_name, body_area, session_count, description, sort_order, performer_profiles(display_name), portfolio_photos(id, photo_type, storage_path, alt_text)')
    .eq('published', true)
    .order('sort_order', { ascending: true })
    .limit(24);
  if (error || !data?.length) {
    section.hidden = true;
    holder.innerHTML = '';
    return;
  }
  const items = await Promise.all(data.map(async item => {
    const photos = await Promise.all((item.portfolio_photos || []).map(async photo => {
      const { data: signed } = await db.storage.from('portfolio-images').createSignedUrl(photo.storage_path, 3600);
      return { ...photo, signedUrl: signed?.signedUrl || '' };
    }));
    return { ...item, portfolio_photos: photos };
  }));
  holder.innerHTML = items.map(item => {
    const afterLabel = publicPortfolioAfterLabel(item.session_count);
    const area = item.body_area ? `<span>${escapeHtml(item.body_area)}</span>` : '';
    const performer = item.performer_profiles?.display_name ? `<span>Мастер: ${escapeHtml(item.performer_profiles.display_name)}</span>` : '';
    const description = item.description ? `<p>${escapeHtml(item.description)}</p>` : '';
    return `<article class="public-portfolio-card"><div class="public-portfolio-photos">${publicPortfolioPhotoMarkup(publicPortfolioPhoto(item, 'before'), 'До')}${publicPortfolioPhotoMarkup(publicPortfolioPhoto(item, 'after'), afterLabel)}</div><div class="public-portfolio-copy"><h3>${escapeHtml(item.procedure_name)}</h3>${area}${performer}${description}</div></article>`;
  }).join('');
  section.hidden = false;
}

function reviewStars(rating) {
  const value = Math.max(0, Math.min(5, Number(rating) || 0));
  return `<span class="review-stars" aria-label="Оценка ${value} из 5">${'★'.repeat(value)}${'☆'.repeat(5 - value)}</span>`;
}

async function loadPublicReviews() {
  const section = $('#reviewsSection');
  const holder = $('#publicReviewsList');
  if (!section || !holder) return;
  const { data, error } = await db.rpc('get_public_booking_reviews');
  if (error || !data?.length) {
    section.hidden = true;
    holder.innerHTML = '';
    return;
  }
  const summary = data[0];
  $('#reviewsAverage').textContent = Number(summary.average_rating || 0).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  $('#reviewsCount').textContent = `${summary.total_reviews} ${Number(summary.total_reviews) === 1 ? 'отзыв' : 'отзывов'} после реальных визитов`;
  holder.innerHTML = data.map(item => `<article class="public-review-card"><div class="public-review-head"><div>${reviewStars(item.rating)}<strong>${escapeHtml(item.reviewer_name || 'Клиент')}</strong></div><time datetime="${escapeHtml(item.created_at)}">${new Date(item.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}</time></div>${item.review_text ? `<p>${escapeHtml(item.review_text)}</p>` : '<p class="review-without-text">Оценка без текста</p>'}<small>${escapeHtml(serviceName(item.service_name))} · ${escapeHtml(item.performer_name)}</small></article>`).join('');
  section.hidden = false;
}

function renderServices() {
  const holder = $('#services');
  const services = visibleServices();
  if (!services.length) {
    holder.innerHTML = state.services.length
      ? state.resourceScheduling && !locationEligibleServices().length
        ? '<div class="empty-service"><strong>В этом филиале пока нет доступных услуг</strong><span>Для услуг ещё не настроен активный кабинет или необходимое оборудование.</span></div>'
        : '<div class="empty-service"><strong>У специалиста пока нет активных услуг</strong><span>Выберите другого специалиста или покажите всю команду.</span></div>'
      : '<div class="empty-service"><span class="empty-service-mark"><svg class="ui-icon" aria-hidden="true"><use href="ui-icons.svg#icon-plus"></use></svg></span><strong>Услуги скоро появятся</strong><span>Исполнитель ещё не добавил услуги в свой кабинет.</span><a href="https://aladushka9180-droid.github.io/anatomy-trainer/minuta-online-booking/provider.html">Войти исполнителю</a></div>';
    $('#toDate').disabled = true;
    $('#serviceDetailsButton').hidden = true;
    renderRepeatBookingNotice();
    return;
  }
  $('#toDate').disabled = !selectedService();
  const showPerformer = state.teamMode && performerOptions().length > 1;
  holder.innerHTML = services.map(item => {
    const duration = Number(item.duration_minutes) === 1 ? 'Поминутная оплата' : durationLabel(item.duration_minutes);
    const performer = showPerformer ? ` · ${escapeHtml(item.performer_profiles?.display_name || 'Специалист')}` : '';
    const label = `${serviceName(item.name)}, ${duration}, ${money(item.price_rub)}${Number(item.duration_minutes) === 1 ? ' за минуту' : ''}`;
    const more = serviceCardHasContent(state.serviceCards.get(item.id))
      ? `<button class="service-info-button" type="button" data-service-info="${escapeHtml(item.id)}" aria-label="Подробнее: ${escapeHtml(serviceName(item.name))}" aria-haspopup="dialog"><span>Подробнее</span><svg class="ui-icon" aria-hidden="true"><use href="ui-icons.svg#icon-arrow-right"></use></svg></button>` : '';
    return `<div class="service-option-row"><button class="option ${item.id === state.serviceId ? 'selected' : ''}" type="button" data-service="${item.id}" aria-label="${escapeHtml(label)}" aria-pressed="${item.id === state.serviceId}"><span class="option-main"><strong>${escapeHtml(serviceName(item.name))}</strong><small>${duration}${performer}</small></span><span class="option-price">${money(item.price_rub)}${Number(item.duration_minutes) === 1 ? '/мин' : ''}</span></button>${more}</div>`;
  }).join('');
  $('#serviceDetailsButton').hidden = true;
  renderRepeatBookingNotice();
}

function renderRepeatBookingNotice() {
  const notice = $('#repeatBookingNotice');
  if (!notice || !isRepeatBooking) return;
  const service = selectedService();
  notice.hidden = false;
  notice.innerHTML = service
    ? `<strong>Услуга выбрана</strong><span>${escapeHtml(serviceName(service.name))} · теперь выберите удобное время.</span>`
    : '<strong>Услуга больше недоступна</strong><span>Выберите другую услугу.</span>';
}

function renderSpecialists() {
  const section = $('#specialistFilter');
  const holder = $('#specialists');
  if (!section || !holder) return;
  const performers = performerOptions();
  if (!state.teamMode) state.performerId = '';
  section.hidden = !state.teamMode || performers.length < 2;
  if (section.hidden) {
    holder.innerHTML = '';
    return;
  }
  holder.innerHTML = [
    `<button type="button" data-performer="" aria-pressed="${!state.performerId}" class="${!state.performerId ? 'selected' : ''}"><span>Все</span><small>${performers.length} специалиста</small></button>`,
    ...performers.map(item => `<button type="button" data-performer="${escapeHtml(item.id)}" aria-pressed="${item.id === state.performerId}" class="${item.id === state.performerId ? 'selected' : ''}"><span>${escapeHtml(item.name)}</span><small>${state.services.filter(service => service.performer_id === item.id).length} услуг</small></button>`)
  ].join('');
}

async function openServiceDetails(serviceId = state.serviceId, { preserveTrigger = false } = {}) {
  const service = state.services.find(item => item.id === serviceId);
  const card = state.serviceCards.get(serviceId);
  if (!service || !serviceCardHasContent(card)) return;
  if (!preserveTrigger) serviceDetailsTrigger = document.activeElement;
  $('#serviceDetailsTitle').textContent = serviceName(service.name);
  const description = $('#serviceDetailsText');
  description.textContent = card.short_description || '';
  description.hidden = !card.short_description;
  const highlights = (Array.isArray(card.highlights) ? card.highlights : []).slice(0, 3);
  $('#serviceDetailsHighlights').innerHTML = highlights.map(item => `<li>${escapeHtml(item)}</li>`).join('');
  $('#serviceDetailsHighlights').hidden = !highlights.length;
  $('#serviceDetailsDuration').textContent = `${Number(service.duration_minutes) === 1 ? 'Поминутная оплата' : `${service.duration_minutes} мин`} · ${service.performer_profiles?.display_name || 'Мастер'}`;
  $('#serviceDetailsPrice').textContent = `${money(service.price_rub)}${Number(service.duration_minutes) === 1 ? '/мин' : ''}`;
  const reviewCount = Number(card.total_reviews || 0);
  const review = $('#serviceDetailsReview');
  review.hidden = reviewCount < 1;
  $('#serviceDetailsRating').textContent = reviewCount ? `★ ${Number(card.average_rating || 0).toLocaleString('ru-RU', { minimumFractionDigits:1, maximumFractionDigits:1 })} · ${reviewCountLabel(reviewCount)}` : '';
  const quote = $('#serviceDetailsLatestReview');
  quote.textContent = card.latest_review_text || '';
  quote.hidden = !card.latest_review_text;
  const important = $('#serviceDetailsImportant');
  important.hidden = !card.important_note;
  important.open = false;
  $('#serviceDetailsImportantText').textContent = card.important_note || '';
  const media = $('#serviceDetailsMedia');
  const image = $('#serviceDetailsImage');
  media.hidden = true;
  image.removeAttribute('src');
  image.alt = card.photo_alt || `Фото услуги «${serviceName(service.name)}»`;
  image.width = Number(card.photo_width || 0);
  image.height = Number(card.photo_height || 0);
  $('#serviceDetailsDialog').dataset.serviceId = service.id;
  if (!$('#serviceDetailsDialog').open) $('#serviceDetailsDialog').showModal();
  if (card.photo_storage_path) {
    const { data } = await db.storage.from('service-images').createSignedUrl(card.photo_storage_path, 900);
    if ($('#serviceDetailsDialog').open && $('#serviceDetailsDialog').dataset.serviceId === service.id && data?.signedUrl) {
      image.src = data.signedUrl;
      media.hidden = false;
    }
  }
}

function closeServiceDetails({ restoreFocus = true } = {}) {
  if ($('#serviceDetailsDialog').open) $('#serviceDetailsDialog').close();
  if (restoreFocus && serviceDetailsTrigger?.isConnected) serviceDetailsTrigger.focus();
}

function serviceReviewMarkup(item) {
  const text = item.review_text ? `<p>${escapeHtml(item.review_text)}</p>` : '<p class="review-without-text">Оценка без текста</p>';
  return `<article><div>${reviewStars(item.rating)}<time datetime="${escapeHtml(item.created_at)}">${new Date(item.created_at).toLocaleDateString('ru-RU', { day:'numeric',month:'long',year:'numeric' })}</time></div>${text}</article>`;
}

async function openServiceReviews() {
  const serviceId = $('#serviceDetailsDialog').dataset.serviceId;
  const service = state.services.find(item => item.id === serviceId);
  const card = state.serviceCards.get(serviceId);
  if (!service || Number(card?.total_reviews || 0) < 1) return;
  closeServiceDetails({ restoreFocus:false });
  $('#serviceReviewsDialog').dataset.serviceId = serviceId;
  $('#serviceReviewsTitle').textContent = serviceName(service.name);
  $('#serviceReviewsSummary').textContent = `★ ${Number(card.average_rating || 0).toLocaleString('ru-RU', { minimumFractionDigits:1,maximumFractionDigits:1 })} · ${reviewCountLabel(card.total_reviews)} после завершённых визитов`;
  $('#serviceReviewsList').innerHTML = '<div class="loading-state"><i></i><span>Загружаем отзывы…</span></div>';
  $('#serviceReviewsDialog').showModal();
  const { data, error } = await db.rpc('get_public_service_reviews_v159', { p_service:serviceId });
  if (!$('#serviceReviewsDialog').open || $('#serviceReviewsDialog').dataset.serviceId !== serviceId) return;
  $('#serviceReviewsList').innerHTML = error || !data?.length
    ? '<p class="service-reviews-empty">Отзывы временно не загрузились.</p>'
    : data.map(serviceReviewMarkup).join('');
}

function closeServiceReviews() {
  const serviceId = $('#serviceReviewsDialog').dataset.serviceId;
  if ($('#serviceReviewsDialog').open) $('#serviceReviewsDialog').close();
  if (serviceId) void openServiceDetails(serviceId, { preserveTrigger:true });
}

function renderDates() {
  if (dates.findIndex(item => item.iso === state.date) > 6) state.moreDates = true;
  const visibleDates = state.moreDates ? dates : dates.slice(0, 7);
  $('#dates').innerHTML = visibleDates.map(item => {
    const hasLoaded = state.availability.has(item.iso);
    const hasSlots = availableBusinessTimes(item.iso, state.availability.get(item.iso) || []).length > 0;
    const unavailable = !state.loadingAvailability && hasLoaded && !hasSlots;
    return `<button class="date ${item.iso === state.date ? 'selected' : ''} ${unavailable ? 'unavailable' : ''}" type="button" data-date="${item.iso}" aria-label="${item.label}${unavailable ? ', нет мест — можно оставить заявку в лист ожидания' : ''}" aria-pressed="${item.iso === state.date}"><small>${item.weekday}</small><strong>${item.day}</strong>${unavailable ? '<i>нет мест</i>' : ''}</button>`;
  }).join('');
  $('#moreDates').hidden = state.moreDates;
}

function renderTimes() {
  const times = availableBusinessTimes(state.date, state.availability.get(state.date) || []);
  const service = selectedService();
  const duration = Number(service?.duration_minutes || 0);
  const durationNote = $('#durationNote');
  if (durationNote) {
    durationNote.innerHTML = state.time && duration
      ? `Выбрано: <strong>${escapeHtml(timeRange(state.time, duration))}</strong>`
      : duration ? `Сеанс длится <strong>${escapeHtml(durationLabel(duration))}</strong>. Выберите время начала — весь интервал должен быть свободен.` : '';
  }
  if (state.loadingAvailability) {
    $('#timePeriods').innerHTML = '';
    $('#timeHours').innerHTML = '<div class="loading-state compact"><i></i><span>Ищем свободное время…</span></div>';
    $('#minutePicker').hidden = true;
  } else {
    const filtered = times;
    $('#timePeriods').innerHTML = '';
    if (!filtered.includes(state.time)) state.time = '';
    const roundHours = availableBusinessTimes(state.date, Array.from({ length: 10 }, (_, index) => `${String(index + 10).padStart(2, '0')}:00`));
    $('#timeHours').innerHTML = roundHours.map(slot => {
      const available = filtered.includes(slot);
      const selected = slot === state.time;
      const range = timeRange(slot, duration);
      const endTime = range.split('–')[1];
      const caption = selected
        ? `до ${endTime} · выбрано`
        : available
          ? `до ${endTime}`
          : duration <= 60
            ? 'занято'
            : 'нет окна';
      const ariaLabel = available ? `${range}${selected ? ', выбрано' : ''}` : `${range}, недоступно для начала: весь интервал должен быть свободен`;
      return `<button class="time-hour ${selected ? 'selected' : ''} ${available ? '' : 'unavailable'}" type="button" ${available ? `data-time="${slot}"` : 'disabled'} aria-label="${ariaLabel}" aria-pressed="${selected}"><strong>${slot}</strong><small>${caption}</small></button>`;
    }).join('');
    const additionalTimes = filtered.filter(time => !time.endsWith(':00'));
    const additionalHours = [...new Set(additionalTimes.map(time => time.slice(0, 2)))];
    $('#minutePicker').hidden = !additionalTimes.length;
    $('#times').innerHTML = additionalHours.map(hour => {
      const hourTimes = additionalTimes.filter(time => time.startsWith(`${hour}:`));
      return `<section class="minute-hour-group"><strong>${hour}:00–${hour}:59</strong><div class="time-grid">${hourTimes.map(item => { const range = timeRange(item, duration); return `<button class="time ${item === state.time ? 'selected' : ''}" type="button" data-time="${item}" aria-label="${range}" aria-pressed="${item === state.time}"><strong>${item}</strong><small>до ${range.split('–')[1]}</small></button>`; }).join('')}</div></section>`;
    }).join('');
    if (state.time && !state.time.endsWith(':00')) $('#minutePicker').open = true;
  }
  $('#continueBooking').disabled = !state.time || state.loadingAvailability;
  const suggestionShown = renderAvailabilitySuggestion(times);
  // Не заставляем клиента прокручивать сетку заведомо недоступных часов.
  // Загрузка остаётся видимой, а при отсутствии окон сразу показывается
  // ближайшее предложение, сообщение об ошибке или лист ожидания.
  $('#timeHours').hidden = !state.loadingAvailability && !times.length;
  $('#noTimes').hidden = state.loadingAvailability || Boolean(times.length) || suggestionShown;
  const waitlistCta = $('#waitlistCta');
  if (waitlistCta) waitlistCta.hidden = state.loadingAvailability || state.availabilityError || !state.date || !service;
}

function renderAvailabilitySuggestion(times) {
  const holder = $('#availabilityHint');
  if (!holder) return false;
  if (state.loadingAvailability || times.length) {
    holder.hidden = true;
    holder.innerHTML = '';
    return false;
  }
  const nearest = dates.find(item => item.iso !== state.date && availableBusinessTimes(item.iso, state.availability.get(item.iso) || []).length);
  if (!nearest) {
    holder.hidden = true;
    holder.innerHTML = '';
    return false;
  }
  const nearestTime = availableBusinessTimes(nearest.iso, state.availability.get(nearest.iso) || []).sort()[0];
  const isToday = state.date === businessClock().date;
  const isTomorrow = nearest.iso === dates[1]?.iso;
  const dateText = isTomorrow ? 'завтра' : `${nearest.weekday}, ${nearest.label}`;
  holder.innerHTML = `<div class="availability-suggestion-icon"><svg class="ui-icon" aria-hidden="true"><use href="ui-icons.svg#icon-spark"></use></svg></div><div><strong>${isToday ? 'Сегодня мест нет' : 'На выбранный день мест нет'}</strong><span>Ближайшее окно — ${escapeHtml(dateText)}, ${escapeHtml(nearestTime)}</span></div><button type="button" data-suggested-date="${nearest.iso}" data-suggested-time="${nearestTime}"><span>Выбрать ${escapeHtml(dateText)}, ${escapeHtml(nearestTime)}</span><svg class="ui-icon" aria-hidden="true"><use href="ui-icons.svg#icon-arrow-right"></use></svg></button>`;
  holder.hidden = false;
  return true;
}

async function loadAvailability() {
  const service = selectedService();
  const requestedLocationId = state.locationId;
  const revision = ++availabilityLoadRevision;
  const isCurrent = () => revision === availabilityLoadRevision
    && selectedService()?.id === service?.id && state.locationId === requestedLocationId;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timeoutId = null;
  let data = [];
  let error = null;
  state.availability = new Map();
  state.availabilityServiceId = '';
  state.availabilityLocationId = '';
  state.time = '';
  state.hour = '';
  state.period = 'all';
  state.availabilityError = false;
  state.loadingAvailability = true;
  renderDates();
  renderTimes();
  if (!service) { state.loadingAvailability = false; renderTimes(); return; }
  try {
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        controller?.abort();
        const timeoutError = new Error('availability_timeout');
        timeoutError.name = 'TimeoutError';
        reject(timeoutError);
      }, AVAILABILITY_REQUEST_TIMEOUT_MS);
    });
    ({ data, error } = await Promise.race([
      loadPublicSlots(service, dates[0].iso, dates[dates.length - 1].iso, requestedLocationId, controller?.signal),
      timeout
    ]));
    if (!isCurrent()) return;
    dates.forEach(item => state.availability.set(item.iso, []));
    if (!error) (data || []).forEach(item => {
      const date = item.booking_date;
      const time = String(item.booking_time).slice(0, 5);
      state.availability.set(date, [...(state.availability.get(date) || []), time]);
    });
    if (!error) {
      state.availabilityServiceId = service.id;
      state.availabilityLocationId = requestedLocationId;
    }
  } catch (requestError) {
    error = requestError || new Error('availability_request_failed');
    if (!isCurrent()) return;
    dates.forEach(item => state.availability.set(item.iso, []));
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (!isCurrent()) return;
    state.availabilityError = Boolean(error);
    state.loadingAvailability = false;
    renderDates();
    renderTimes();
    if (error) {
      const online = navigator.onLine;
      const timedOut = error?.name === 'TimeoutError';
      setBookingStatus(online ? 'error' : 'offline', online ? 'Расписание временно недоступно' : 'Нет соединения с интернетом');
      $('#noTimes').innerHTML = `<span>${timedOut ? 'Расписание загружается дольше обычного.' : 'Не удалось загрузить расписание.'}</span><button class="service-details-button" type="button" id="retryAvailability">Повторить</button>`;
      $('#noTimes').hidden = false;
    } else {
      setBookingStatus('open', 'Запись открыта');
      $('#noTimes').textContent = 'На эту дату свободного времени нет. Выберите другой день.';
    }
  }
}

function openWaitlistDialog() {
  const service = selectedService();
  const date = selectedDate();
  if (!service || !date || waitlistSubmissionPending || state.loadingAvailability || state.availabilityError) return;
  const locationItem = state.locations.find(item => item.id === state.locationId);
  if (state.teamMode && (!state.organization?.public_slug || !locationItem)) return;
  waitlistContext = { serviceId:service.id, date:state.date, dateLabel:date.label,
    teamMode:state.teamMode, slug:state.organization?.public_slug || '', locationId:state.locationId };
  $('#waitlistForm').hidden = false;
  $('#waitlistSuccess').hidden = true;
  $('#waitlistError').hidden = true;
  $('#waitlistService').textContent = [serviceName(service.name),service.performer_profiles?.display_name, state.teamMode ? locationItem?.name : ''].filter(Boolean).join(' · ');
  $('#waitlistDate').textContent = date.label;
  $('#waitlistName').value = $('#clientName')?.value || '';
  $('#waitlistPhone').value = $('#clientPhone')?.value || '';
  $('#waitlistConsent').checked = false;
  $('#waitlistPeriod').value = 'any';
  $('#waitlistDialog').showModal();
}

async function submitWaitlist(event) {
  event.preventDefault();
  if (waitlistSubmissionPending) return;
  const context = waitlistContext;
  const name = $('#waitlistName').value.trim();
  const phone = $('#waitlistPhone').value;
  const phoneDigits = phone.replace(/\D/g, '');
  const errorHolder = $('#waitlistError');
  errorHolder.hidden = true;
  if (!context || context.serviceId !== state.serviceId || context.date !== state.date
    || context.teamMode !== state.teamMode || context.locationId !== state.locationId
    || context.slug !== (state.organization?.public_slug || '')) {
    errorHolder.textContent = 'Услуга или место приёма изменились. Закройте форму и откройте её снова.';
    errorHolder.hidden = false;
    return;
  }
  if (name.length < 2 || name.length > 80 || phoneDigits.length !== 11 || !$('#waitlistConsent').checked) {
    errorHolder.textContent = 'Укажите имя, полный номер телефона и подтвердите согласие.';
    errorHolder.hidden = false;
    return;
  }
  const button = $('#submitWaitlist');
  waitlistSubmissionPending = true;
  button.disabled = true;
  button.textContent = 'Отправляем…';
  try {
    const args = {
      p_service: context.serviceId,
      p_date: context.date,
      p_time_period: $('#waitlistPeriod').value,
      p_client_name: name,
      p_client_phone: phoneDigits
    };
    if (context.teamMode) Object.assign(args,{p_slug:context.slug,p_location:context.locationId});
    const { data, error } = await db.rpc(context.teamMode ? 'join_minuta_waitlist_v111' : 'join_booking_waitlist',args);
    if (error || !data?.[0]?.manage_token) {
      throw error || new Error('waitlist_response_missing');
    }
    const manageUrl = new URL('waitlist.html', location.href);
    if (context.teamMode) manageUrl.searchParams.set('scope','organization');
    manageUrl.hash = `token=${encodeURIComponent(data[0].manage_token)}`;
    $('#waitlistManageLink').href = manageUrl.href;
    $('#waitlistSuccessText').textContent = `Заявка ${data[0].request_code} на ${context.dateLabel} сохранена. Мастер увидит её в кабинете и свяжется с вами. Это ещё не запись на сеанс.`;
    $('#waitlistForm').hidden = true;
    $('#waitlistSuccess').hidden = false;
  } catch (error) {
    errorHolder.textContent = context.teamMode && /PGRST202|42883/.test(String(error?.code || ''))
      ? 'Лист ожидания этого филиала пока не подключён. Свяжитесь с мастером.'
      : error?.message === 'waitlist_request_already_exists'
      ? 'Заявка с этим телефоном на эту дату уже есть. Используйте сохранённую ссылку или свяжитесь с мастером.'
      : 'Не удалось добавить заявку. Проверьте соединение и попробуйте ещё раз.';
    errorHolder.hidden = false;
  } finally {
    waitlistSubmissionPending = false;
    button.disabled = false;
    button.textContent = 'Оставить заявку';
  }
}

async function showStep(step) {
  state.step = step;
  document.body.dataset.bookingStep = String(step);
  const titles = { 1: 'Выберите услугу', 2: 'Выберите дату и время', 3: 'Ваши контактные данные' };
  const kickers = { 1: 'Услуга', 2: 'Время', 3: 'Контакты' };
  $$('.step').forEach(item => item.classList.toggle('active', Number(item.dataset.step) === step));
  $$('.progress i').forEach((item, index) => item.classList.toggle('active', index < step));
  $$('[data-progress-label]').forEach(item => item.classList.toggle('active', Number(item.dataset.progressLabel) <= step));
  $('#bookingTitle').textContent = titles[step];
  $('#stepKicker').textContent = kickers[step];
  $('#stepLabel').textContent = `${step} из 3`;
  const bookingCard = $('.booking-card');
  requestAnimationFrame(() => bookingCard?.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start'
  }));
  if (step === 2) {
    if (dates[0].iso !== businessClock().date) {
      dates.splice(0, dates.length, ...createDates()); state.date = dates[0].iso; state.availability = new Map(); state.time = '';
    }
    if (state.availabilityServiceId === state.serviceId && state.availabilityLocationId === state.locationId && state.availability.size) {
      renderDates();
      renderTimes();
    } else await loadAvailability();
    if (selectedService()) void trackBookingFunnelEvent('slots_viewed', { serviceId:state.serviceId });
  }
  if (step === 3) {
    renderSummary();
    await validateCurrentSelection();
    if (!selectionValidationBlocked) void trackBookingFunnelEvent('details_started', { serviceId:state.serviceId });
    updateSubmitAvailability();
  }
}

function renderSummary() {
  const service = selectedService();
  const location = state.teamMode ? state.locations.find(item => item.id === state.locationId) : null;
  const locationLabel = location ? ` · ${escapeHtml(location.name || 'Филиал')}` : '';
  $('#summary').innerHTML = `<small>Ваша запись</small><strong>${escapeHtml(serviceName(service.name))} · ${money(service.price_rub)}${Number(service.duration_minutes) === 1 ? '/мин' : ''}</strong><span>${escapeHtml(service.performer_profiles?.display_name || 'Мастер')}${locationLabel} · ${selectedDate().label}, ${timeRange(state.time, service.duration_minutes)}</span>`;
}
function httpsPaymentUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
async function getPaymentCapability(manageToken) {
  if (!/^[0-9a-f-]{36}$/i.test(manageToken || '')) return null;
  try {
    const { data, error } = await db.rpc('get_yookassa_payment_capability', { p_manage_token: manageToken });
    return error || !data || typeof data !== 'object' || Array.isArray(data) ? null : data;
  } catch { return null; }
}
function renderSuccessPayment(item, capability = null, manageToken = '') {
  const holder = $('#successPayment');
  if (!holder) return;
  const link = $('#successPaymentLink');
  const legacyUrl = httpsPaymentUrl(item?.payment_url);
  const capabilityUrl = httpsPaymentUrl(capability?.payment_url);
  const fallbackUrl = httpsPaymentUrl(capability?.fallback_url) || legacyUrl;
  const pending = item?.payment_status === 'pending' && Number(item.deposit_amount_rub || 0) > 0;
  const available = capability ? capability.available === true && (!item || pending) : pending && Boolean(legacyUrl);
  const canCreate = available && capability?.can_create === true && /^[0-9a-f-]{36}$/i.test(manageToken || '');
  holder.hidden = !available;
  const note = holder.querySelector('p');
  if (note) note.textContent = 'После оплаты статус обновится автоматически. Сохраните чек до подтверждения.';
  link.removeAttribute('aria-busy');
  delete link.dataset.paymentToken;
  if (!available) { link.href = '#'; return; }
  $('#successDeposit').textContent = `Предоплата ${money(capability?.deposit_amount_rub ?? item?.deposit_amount_rub ?? 0)}`;
  link.href = capabilityUrl || fallbackUrl || '#';
  if (canCreate) link.dataset.paymentToken = manageToken;
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

async function startOnlinePayment(link) {
  if (link.getAttribute('aria-busy') === 'true') return;
  const manageToken = link.dataset.paymentToken;
  const fallbackUrl = httpsPaymentUrl(link.getAttribute('href'));
  if (!/^[0-9a-f-]{36}$/i.test(manageToken || '') || !navigator.onLine) {
    if (fallbackUrl) location.href = fallbackUrl;
    else {
      const note = $('#successPayment')?.querySelector('p');
      if (note) note.textContent = 'Для оплаты требуется интернет. Запись уже сохранена.';
    }
    return;
  }
  link.setAttribute('aria-busy', 'true');
  const previous = link.textContent;
  link.textContent = 'Открываем оплату…';
  try {
    const response = await fetch(yookassaPaymentEndpoint, {
      method:'POST',
      headers:{ 'content-type':'application/json', apikey:window.MINUTA_CONFIG.supabaseKey },
      body:JSON.stringify({ manage_token:manageToken, request_id:paymentRequestId(manageToken) })
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok && result?.ok && result.status === 'succeeded') {
      link.removeAttribute('aria-busy');
      link.textContent = previous;
      $('#successPayment').hidden = true;
      return;
    }
    const paymentUrl = httpsPaymentUrl(result?.payment_url);
    if (!response.ok || !result?.ok || !paymentUrl) throw new Error(result?.error || 'payment_unavailable');
    location.href = paymentUrl;
  } catch {
    link.removeAttribute('aria-busy');
    link.textContent = previous;
    if (fallbackUrl) location.href = fallbackUrl;
    else {
      const note = $('#successPayment')?.querySelector('p');
      if (note) note.textContent = 'Не удалось открыть оплату. Запись сохранена — попробуйте снова позже.';
    }
  }
}
function successDetailsMarkup(service, performer, dateLabel, range) {
  return `<strong>${escapeHtml(service)}</strong><span>${escapeHtml(performer)}</span><b>${escapeHtml(dateLabel)} · ${escapeHtml(range)}</b>`;
}
let currentSuccessCalendarEvent = null;
function calendarStartMs(date, time, addMinutes = 0) {
  const [year, month, day] = String(date).split('-').map(Number);
  const [hour, minute] = String(time).slice(0, 5).split(':').map(Number);
  return Date.UTC(year, month - 1, day, hour - 4, minute + addMinutes);
}
function calendarTimestamp(date, time, addMinutes = 0) { return new Date(calendarStartMs(date, time, addMinutes)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
function calendarUtcTimestamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
function calendarText(value) { return String(value).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1'); }
function buildSuccessCalendarEvent({ service, performer, location: eventLocation, date, time, duration, uid }) {
  return {
    uid,
    date,
    time: String(time).slice(0, 5),
    title: `${service} — Массаж в Ижевске`,
    description: `Исполнитель: ${performer}`,
    location: eventLocation || 'Ижевск, ул. Карла Маркса, 304б',
    startMs: calendarStartMs(date, time),
    endMs: calendarStartMs(date, time, duration),
    start: calendarTimestamp(date, time),
    end: calendarTimestamp(date, time, duration)
  };
}
function successCalendarFile() {
  const event = currentSuccessCalendarEvent;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'PRODID:-//MassageIzhevsk//Booking//RU', 'BEGIN:VEVENT', `UID:${calendarText(event.uid)}@massage-izhevsk`, `DTSTAMP:${calendarUtcTimestamp()}`, `DTSTART:${event.start}`, `DTEND:${event.end}`, `SUMMARY:${calendarText(event.title)}`, `DESCRIPTION:${calendarText(event.description)}`, `LOCATION:${calendarText(event.location)}`, 'END:VEVENT', 'END:VCALENDAR', ''];
  return new File([lines.join('\r\n')], `massage-${event.date}-${event.time.replace(':', '-')}.ics`, { type: 'text/calendar' });
}
function openCalendarFile(file = successCalendarFile()) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.type = 'text/calendar';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function shareCalendarFile(file = successCalendarFile()) {
  if (typeof navigator.share !== 'function') return false;
  const payload = { files:[file], title:currentSuccessCalendarEvent?.title || 'Запись в календарь' };
  if (typeof navigator.canShare === 'function' && !navigator.canShare(payload)) return false;
  try {
    await navigator.share(payload);
    return true;
  } catch (error) {
    return error?.name === 'AbortError';
  }
}
async function addAppleCalendar() {
  const file = successCalendarFile();
  if (!await shareCalendarFile(file)) openCalendarFile(file);
}
async function addAndroidCalendar(event) {
  event?.preventDefault();
  const file = successCalendarFile();
  if (!await shareCalendarFile(file)) location.href = androidCalendarIntent(currentSuccessCalendarEvent);
}
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
function openSuccessCalendar() {
  if (!currentSuccessCalendarEvent) return;
  const dialog = $('#calendarDialog');
  if (!dialog || typeof dialog.showModal !== 'function') { void addAppleCalendar(); return; }
  $('#addAndroidCalendar').href = androidCalendarIntent(currentSuccessCalendarEvent);
  dialog.showModal();
}
async function validateCurrentSelection() {
  // An already committed request can occupy this slot: resolve its nonce,
  // never use availability as evidence that the earlier write did not happen.
  if (bookingAttempt && (!bookingAttempt.scope || bookingAttempt.scope === bookingScopeKey())) {
    setSelectionValidationState('ready'); renderSummary(); return;
  }
  const service = selectedService();
  const selectedTime = state.time;
  const selectedBookingDate = state.date;
  const selectedLocationId = state.locationId;
  if (!service || !selectedTime) { await showStep(2); return; }
  setSelectionValidationState('checking');
  const { data, error } = await loadPublicSlots(service, selectedBookingDate, selectedBookingDate, selectedLocationId);
  if (selectedService()?.id !== service.id || state.date !== selectedBookingDate || state.time !== selectedTime || state.locationId !== selectedLocationId) return;
  if (error) {
    setSelectionValidationState('failed');
    setBookingStatus(navigator.onLine ? 'error' : 'offline', navigator.onLine ? 'Не удалось перепроверить выбранное время' : 'Нет соединения с интернетом');
    return;
  }
  const available = (data || []).some(item => String(item.booking_time).slice(0, 5) === selectedTime);
  if (!available) {
    state.time = '';
    await showStep(2);
    setBookingStatus('error', 'Выбранное время стало недоступно — выберите другое');
    return;
  }
  setSelectionValidationState('ready');
  renderSummary();
}
function formatPhone(value) { let digits = value.replace(/\D/g, '').slice(0, 11); if (!digits) return ''; if (digits[0] === '8') digits = `7${digits.slice(1)}`; if (digits[0] !== '7') digits = `7${digits}`.slice(0, 11); const p = digits.slice(1); return `+7${p.length ? ` (${p.slice(0, 3)}` : ''}${p.length >= 3 ? ')' : ''}${p.length > 3 ? ` ${p.slice(3, 6)}` : ''}${p.length > 6 ? `-${p.slice(6, 8)}` : ''}${p.length > 8 ? `-${p.slice(8, 10)}` : ''}`; }
function showError(message) { $('#formError').textContent = message; $('#formError').hidden = false; }
function prepareTelegramAuthorization(manageToken) {
  return window.MinutaTelegramAuth?.prepare({
    button: $('#telegramConnect'),
    manageToken,
    endpoint: telegramClientEndpoint,
    apikey: window.MINUTA_CONFIG.supabaseKey
  });
}
function notifyTelegramEvent(event, manageToken) {
  if (!manageToken) return;
  fetch(`${telegramClientEndpoint}/event`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: window.MINUTA_CONFIG.supabaseKey },
    body: JSON.stringify({ event, manage_token: manageToken })
  }).catch(() => {});
}
function saveClientSession(token) {
  if (!/^[0-9a-f]{64}$/i.test(token || '')) return;
  try {
    sessionStorage.setItem(CLIENT_SESSION_KEY, token);
    localStorage.removeItem(CLIENT_SESSION_KEY);
  } catch {}
}
function clientAccessShareMessage(code, phone) { return `Мои записи на массаж: ${new URL('my-bookings.html', location.href).href}\nТелефон: ${phone}\nЛичный код: ${code}\nНе пересылайте код посторонним.`; }
function downloadClientAccessFile(code, phone) {
  const file = new Blob([`${clientAccessShareMessage(code, phone)}\n`], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'lichnyy-kod-moi-zapisi.txt';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
function renderClientAccess(result, phone) {
  if (!result?.session_token) return;
  saveClientSession(result.session_token);
  $('#myBookingsSuccess').hidden = false;
  if (!result.access_code) return;
  $('#clientAccessCode').textContent = result.access_code;
  $('#clientAccessNote').textContent = 'Вход сохранён только до закрытия этой вкладки. Код сохранится в файл; если загрузка не началась, нажмите кнопку ниже.';
  $('#clientAccessDownload').onclick = () => downloadClientAccessFile(result.access_code, phone);
  const text = clientAccessShareMessage(result.access_code, phone);
  $('#clientAccessWhatsapp').href = `https://wa.me/?text=${encodeURIComponent(text)}`;
  $('#clientAccessTelegram').href = `https://t.me/share/url?url=${encodeURIComponent(new URL('my-bookings.html', location.href).href)}&text=${encodeURIComponent(text)}`;
  $('#clientAccessShare').hidden = false;
  $('#clientAccessResult').hidden = false;
  downloadClientAccessFile(result.access_code, phone);
}
async function bootstrapClientAccess(manageToken, phone, isCurrent = () => true) {
  if (!manageToken) return;
  const { data } = await db.rpc('bootstrap_client_access', { p_manage_token: manageToken, p_device_name: navigator.userAgent.slice(0, 120) });
  if (isCurrent()) renderClientAccess(data?.[0], phone);
}

async function submitBooking(event) {
  event.preventDefault();
  if (bookingSubmissionPending) return;
  restoreBookingRequest();
  if (selectionValidationPending && !bookingAttempt) { showError('Подождите, пока выбранное время будет перепроверено.'); return; }
  if (selectionValidationBlocked && !bookingAttempt) { showError('Сначала обновите расписание и перепроверьте выбранное время.'); return; }
  const name = $('#clientName').value.trim();
  const phone = $('#clientPhone').value;
  const benefitCode = ($('#bookingBenefitCode')?.value || '').trim();
  const service = selectedService();
  if (name.length < 2 || phone.replace(/\D/g, '').length !== 11) { showError('Укажите имя и полный номер телефона.'); return; }
  if (!$('#dataConsent').checked) { showError('Подтвердите согласие на обработку данных.'); return; }
  if (!service || !state.time) { showError('Выберите услугу и свободное время.'); return; }
  if (state.teamMode && !state.locations.length) { showError('Запись в филиал пока не активирована. Запись не создана — обновите страницу позже или свяжитесь со специалистом.'); return; }
  if (state.teamMode && !state.locationId) { showError('Выберите филиал для записи.'); return; }
  if (benefitCode && !state.teamMode) { showError('Сертификаты и абонементы доступны только на странице организации. Уберите код или откройте ссылку организации.'); return; }
  if (!navigator.onLine) { showError(bookingAttempt ? 'Нет соединения. Исходный результат ещё не подтверждён — подключитесь к сети для проверки.' : 'Нет соединения с интернетом. Запись не создана — подключитесь к сети и повторите попытку.'); return; }
  const scope = bookingScopeKey(), revision = bookingFormRevision;
  const isCurrent = () => revision === bookingFormRevision && scope === bookingScopeKey();
  const wasUncertain = bookingResultUncertain;
  bookingSubmissionPending = true;
  lockBookingContacts(true);
  updateSubmitAvailability();
  try {
  const attempt = await currentBookingAttempt(service, name, phone, benefitCode);
  if (!isCurrent()) return;
  if (!attempt.request) {
    attempt.rpc = benefitCode ? 'book_minuta_appointment_with_benefit_v115' : (state.teamMode ? 'book_minuta_appointment' : 'book_appointment');
    attempt.request = Object.freeze({ p_request_id: attempt.requestId, p_service:service.id, p_date:state.date, p_time:`${state.time}:00`,
      p_client_name:name, p_client_phone:phone, ...(state.teamMode ? { p_slug:requestedOrganizationSlug, p_location:state.locationId } : {}),
      ...(benefitCode ? { p_benefit_code:benefitCode } : {}) });
  }
  bookingResultUncertain = true;
  const submit = $('#submitBooking');
  submit.disabled = true;
  setSubmitLabel(bookingResultUncertain ? 'Проверяем…' : 'Сохраняем…');
  $('#formError').hidden = true;
  const bookingResult = await db.rpc(attempt.rpc, attempt.request);
  if (!isCurrent()) { bookingResultUncertain = true; return; }
  if (!bookingResult || typeof bookingResult !== 'object') throw new Error('invalid_booking_response');
  const { data, error } = bookingResult;
  setSubmitLabel(bookingResultUncertain ? 'Проверить результат' : 'Подтвердить запись');
  updateSubmitAvailability();
  if (error) {
    const missingTeamBookingRpc = state.teamMode && ['PGRST202', '42883'].includes(error.code) && isMissingRpc(error, attempt.rpc);
    const benefitRejected = ['invalid_benefit_code', 'benefits_disabled', 'benefit_code_not_found', 'benefit_client_mismatch', 'benefit_not_available', 'insufficient_certificate_balance', 'package_service_exhausted', 'visit_pass_not_applicable', 'booking_already_has_benefit', 'booking_payment_already_started', 'benefit_request_conflict'].includes(error.message);
    if (!wasUncertain && missingTeamBookingRpc) {
      clearBookingAttempt();
      showError(benefitCode ? 'Применение сертификата или абонемента пока не активировано. Запись не создана — уберите код или повторите позже.' : 'Запись в филиал пока не активирована. Запись не создана — обновите страницу позже или свяжитесь со специалистом.');
    } else if (!wasUncertain && error.message === 'client_online_booking_blocked') {
      clearBookingAttempt();
      showError('Онлайн-запись для этого номера недоступна. Свяжитесь с организацией — сотрудник сможет записать вас вручную.');
    } else if (benefitCode && bookingDefiniteRejection(error) && benefitRejected) {
      clearBookingAttempt();
      showError('Сертификат или абонемент не подходит: сервер проверил владельца, срок, услугу, оплату и остаток. Проверьте код; если нужна предоплата, обратитесь в организацию или запишитесь без кода.');
    } else if (!wasUncertain && bookingDefiniteRejection(error)) {
      clearBookingAttempt();
      const slotRejected = ['slot_unavailable', 'resource_unavailable', 'booking_buffer_conflict'].includes(error.message);
      showError(slotRejected ? 'Это время больше недоступно. Выберите другое.' : 'Сервер отклонил заявку. Проверьте услугу, филиал и контактные данные.');
      if (slotRejected) await showStep(2);
    } else {
      bookingResultUncertain = true;
      setSubmitLabel('Проверить результат');
      updateSubmitAvailability();
      showError('Сервер не подтвердил результат. Нажмите «Проверить результат»: повторный запрос безопасно вернёт уже созданную запись и не создаст дубль.');
    }
    return;
  }
  const manageToken = data?.[0]?.manage_token;
  if (!bookingReplyIsValid(data)) throw new Error('invalid_booking_response');
  const { data: management, error: managementError } = await db.rpc('get_booking_management', { p_token:manageToken });
  if (!isCurrent()) { bookingResultUncertain = true; return; }
  const current = management?.[0];
  if (managementError || !current || current.booking_code !== data[0].booking_code
    || !['new', 'confirmed', 'cancelled'].includes(current.status)
    || typeof current.booking_date !== 'string' || typeof current.booking_time !== 'string'
    || typeof current.service_name !== 'string') throw new Error('booking_status_unconfirmed');
  if (manageToken) void db.rpc('record_minuta_booking_legal_acceptance_v110', { p_token:manageToken, p_privacy_version:'2026-09-05', p_terms_version:'2026-09-05' }).then(({ error }) => { if (error) console.warn('Legal acceptance was not recorded:', error.message); }).catch(() => {});
  void trackBookingFunnelEvent('booking_created', { serviceId:service.id, manageToken });
  const bookedLocation = state.teamMode ? state.locations.find(item => item.id === state.locationId) : null;
  const currentDate = new Date(`${current.booking_date}T00:00:00`);
  const currentDateLabel = currentDate.toLocaleDateString('ru-RU', { weekday:'short', day:'numeric', month:'long' });
  currentSuccessCalendarEvent = buildSuccessCalendarEvent({ service:current.service_name, performer:current.performer_name || 'Мастер', location:bookedLocation?.address || bookedLocation?.name || '', date:current.booking_date, time:current.booking_time, duration:current.duration_minutes, uid:current.booking_code });
  saveClientContact(name, phone);
  clearBookingAttempt();
  $('#bookingFlow').hidden = true;
  $('#success').hidden = false;
  $('#successTitle').textContent = current.status === 'cancelled' ? 'Эта запись уже отменена' : `До встречи, ${name.split(/\s+/)[0]}!`;
  $('#successDetails').innerHTML = successDetailsMarkup(current.service_name, current.performer_name || 'Мастер', currentDateLabel, timeRange(current.booking_time.slice(0, 5), current.duration_minutes));
  if (manageToken) {
    const manageUrl = new URL('booking.html', location.href);
    manageUrl.hash = `token=${encodeURIComponent(manageToken)}`;
    $('#manageBooking').href = manageUrl.href;
    $('#manageBooking').hidden = false;
    $('#telegramConnect').hidden = false;
    void Promise.resolve(prepareTelegramAuthorization(manageToken)).catch(() => {});
    await bootstrapClientAccess(manageToken, phone, isCurrent);
    if (!isCurrent()) return;
    const paymentCapability = await getPaymentCapability(manageToken);
    if (!isCurrent()) return;
    renderSuccessPayment(current, paymentCapability, manageToken);
    if (current.status !== 'cancelled') notifyTelegramEvent('confirmation', manageToken);
  }
  $('.booking-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    if (!isCurrent()) return;
    if (!bookingAttempt && !$('#success').hidden) { showError('Запись найдена, но дополнительные данные не загрузились. Откройте страницу управления записью.'); return; }
    bookingResultUncertain = Boolean(bookingAttempt);
    showError(error?.message === 'booking_attempt_unresolved'
      ? 'Сначала проверьте исходную запись: восстановите ту же услугу, дату, время и контакты. Новая заявка не отправлена. Если данные не помните, уточните результат у специалиста.'
      : 'Не удалось подтвердить результат. Повторите проверку исходной записи; её параметры и номер запроса сохранены.');
  } finally {
    bookingSubmissionPending = false;
    if (isCurrent()) {
      setSubmitLabel(bookingResultUncertain ? 'Проверить результат' : 'Подтвердить запись');
    }
    lockBookingContacts(Boolean(bookingAttempt?.request && !bookingAttempt.detached));
    updateSubmitAvailability();
  }
}

function resetFlow() {
  bookingFormRevision += 1;
  if (bookingAttempt) { bookingAttempt.detached = true; bookingResultUncertain = true; }
  lockBookingContacts(false);
  // Telegram's helper owns async state by DOM node. Detach the old node so
  // its pending preparation cannot repaint or authorize the next form.
  const telegramButton = $('#telegramConnect');
  if (telegramButton?.cloneNode && telegramButton?.replaceWith) {
    const replacement = telegramButton.cloneNode(true);
    delete replacement.dataset.telegramAuthBound;
    telegramButton.replaceWith(replacement);
  }
  $('#success').hidden = true; $('#successPayment').hidden = true; $('#clientAccessResult').hidden = true; $('#clientAccessShare').hidden = true; $('#bookingFlow').hidden = false; $('#manageBooking').hidden = true; $('#myBookingsSuccess').hidden = true; $('#telegramConnect').hidden = true; $('#bookingForm').reset(); if ($('.booking-benefit')) $('.booking-benefit').open = false; restoreClientContact(); $('#formError').hidden = true; currentSuccessCalendarEvent = null; state.time = ''; state.moreDates = false; setSelectionValidationState('ready'); updateSubmitAvailability(); showStep(1);
}
document.addEventListener('click', event => {
  if ((bookingSubmissionPending || (bookingAttempt?.request && !bookingAttempt.detached)) && event.target.closest('[data-performer], [data-service], [data-choose-service-details], [data-date], [data-time], [data-suggested-date], [data-time-period], [data-back], [data-next], #moreDates')) {
    event.preventDefault(); showError('Сначала проверьте результат исходной записи.'); return;
  }
  const performer = event.target.closest('[data-performer]');
  const service = event.target.closest('[data-service]');
  const date = event.target.closest('[data-date]');
  const time = event.target.closest('[data-time]');
  const period = event.target.closest('[data-time-period]');
  const moreDates = event.target.closest('#moreDates');
  const serviceDetails = event.target.closest('#serviceDetailsButton');
  const serviceInfo = event.target.closest('[data-service-info]');
  const closeServiceDetailsButton = event.target.closest('[data-close-service-details]');
  const chooseServiceDetails = event.target.closest('[data-choose-service-details]');
  const openServiceReviewsButton = event.target.closest('[data-open-service-reviews]');
  const closeServiceReviewsButton = event.target.closest('[data-close-service-reviews]');
  const suggestedDate = event.target.closest('[data-suggested-date]');
  const next = event.target.closest('[data-next]');
  const back = event.target.closest('[data-back]');
  const retryServices = event.target.closest('#retryServices');
  const retryAvailability = event.target.closest('#retryAvailability');
  const openWaitlist = event.target.closest('#openWaitlist');
  const closeWaitlist = event.target.closest('[data-close-waitlist]');
  const paymentLink = event.target.closest('#successPaymentLink[data-payment-token]');
  const openClientTheme = event.target.closest('#openClientTheme');
  if (openClientTheme) { renderClientThemeOptions(); $('#clientThemeDialog')?.showModal(); return; }
  if (paymentLink) { event.preventDefault(); void startOnlinePayment(paymentLink); return; }
  if (performer) {
    const nextPerformer = performer.dataset.performer || '';
    if (state.performerId !== nextPerformer) {
      state.performerId = nextPerformer;
      const services = visibleServices();
      if (!services.some(item => item.id === state.serviceId)) state.serviceId = '';
      state.availability = new Map();
      state.availabilityServiceId = '';
      state.time = '';
      renderSpecialists();
      renderServices();
      setBookingStatus(services.length ? 'open' : 'closed', services.length ? 'Запись открыта' : 'У специалиста пока нет услуг');
    }
  }
  if (service) {
    bookingInputChanged();
    if (state.serviceId !== service.dataset.service) {
      state.serviceId = service.dataset.service;
      state.availability = new Map();
      state.availabilityServiceId = '';
      state.time = '';
    }
    renderServices();
    if (state.serviceId) void trackBookingFunnelEvent('service_selected', { serviceId:state.serviceId });
    if (state.serviceId) void showStep(2);
  }
  if (date && !date.disabled) { bookingInputChanged(); state.date = date.dataset.date; state.time = ''; state.hour = ''; state.period = 'all'; renderDates(); renderTimes(); }
  if (suggestedDate) {
    if (!availableBusinessTimes(suggestedDate.dataset.suggestedDate, [suggestedDate.dataset.suggestedTime]).length) { renderDates(); renderTimes(); return; }
    bookingInputChanged();
    state.date = suggestedDate.dataset.suggestedDate;
    state.time = suggestedDate.dataset.suggestedTime;
    state.hour = state.time.slice(0, 2);
    state.period = 'all';
    renderDates();
    renderTimes();
    void showStep(3);
  }
  if (period && !period.disabled) { state.period = period.dataset.timePeriod; state.hour = ''; state.time = ''; renderTimes(); }
  if (moreDates) { state.moreDates = true; renderDates(); }
  if (serviceInfo) void openServiceDetails(serviceInfo.dataset.serviceInfo);
  if (serviceDetails) void openServiceDetails();
  if (openServiceReviewsButton) void openServiceReviews();
  if (closeServiceReviewsButton) closeServiceReviews();
  if (closeServiceDetailsButton || chooseServiceDetails) closeServiceDetails({ restoreFocus:!chooseServiceDetails });
  if (chooseServiceDetails) {
    const choice = visibleServices().find(item => item.id === $('#serviceDetailsDialog').dataset.serviceId);
    if (choice) { bookingInputChanged(); state.serviceId = choice.id; state.availability = new Map(); state.time = ''; renderServices(); void showStep(2); }
  }
  if (time && !time.disabled) { if (!availableBusinessTimes(state.date, [time.dataset.time]).length) { renderTimes(); return; } bookingInputChanged(); state.time = time.dataset.time; renderTimes(); void showStep(3); }
  if (next) showStep(Number(next.dataset.next));
  if (back) showStep(Number(back.dataset.back));
  if (retryServices) loadServices();
  if (retryAvailability && state.step === 2 && state.serviceId && !state.loadingAvailability) void loadAvailability();
  if (openWaitlist) openWaitlistDialog();
  if (closeWaitlist) $('#waitlistDialog').close();
});
$('#clientThemeOptions')?.addEventListener('change', event => {
  if (!event.target.matches('input[name="clientTheme"]')) return;
  window.MinutaThemeCatalog?.writeClientOverride(state.organization?.id, event.target.value, requestedOrganizationSlug);
  applyClientPagePresentation();
});
$('#clientThemeDialog')?.addEventListener('click', event => { if (event.target === $('#clientThemeDialog')) $('#clientThemeDialog').close(); });
$('#serviceDetailsDialog')?.addEventListener('click', event => { if (event.target === $('#serviceDetailsDialog')) closeServiceDetails(); });
$('#serviceReviewsDialog')?.addEventListener('click', event => { if (event.target === $('#serviceReviewsDialog')) closeServiceReviews(); });
$('#serviceDetailsDialog')?.addEventListener('cancel', event => { event.preventDefault(); closeServiceDetails(); });
$('#serviceReviewsDialog')?.addEventListener('cancel', event => { event.preventDefault(); closeServiceReviews(); });
$('#clientName').addEventListener('input', bookingInputChanged);
$('#clientPhone').addEventListener('input', event => { event.target.value = formatPhone(event.target.value); bookingInputChanged(); });
$('#bookingBenefitCode')?.addEventListener('input', bookingInputChanged);
$('#dataConsent').addEventListener('change', bookingInputChanged);
$('#bookingForm').addEventListener('submit', submitBooking);
$('#locationSelect')?.addEventListener('change', async event => {
  if (bookingSubmissionPending || (bookingAttempt?.request && !bookingAttempt.detached)) { event.target.value = state.locationId; showError('Сначала проверьте результат исходной записи.'); return; }
  const nextLocation = event.target.value || '';
  if (state.locationId === nextLocation) return;
  state.locationId = nextLocation;
  availabilityLoadRevision += 1;
  state.availability = new Map();
  state.availabilityServiceId = '';
  state.availabilityLocationId = '';
  state.loadingAvailability = false;
  state.availabilityError = false;
  state.time = '';
  if (state.performerId && !locationEligibleServices().some(item => item.performer_id === state.performerId)) state.performerId = '';
  if (!visibleServices().some(item => item.id === state.serviceId)) state.serviceId = '';
  bookingInputChanged();
  renderLocations();
  renderSpecialists();
  renderServices();
  renderTimes();
  setBookingStatus(visibleServices().length ? 'open' : 'closed', visibleServices().length ? 'Запись открыта' : 'В этом филиале пока нет доступных услуг');
  if (state.step === 2 && state.serviceId) await loadAvailability();
});
$('#waitlistPhone').addEventListener('input', event => { event.target.value = formatPhone(event.target.value); });
$('#waitlistForm').addEventListener('submit', submitWaitlist);
$('#newBooking').addEventListener('click', resetFlow);
$('#saveSuccessCalendar').addEventListener('click', openSuccessCalendar);
$('#addAppleCalendar').addEventListener('click', async () => { await addAppleCalendar(); $('#calendarDialog').close(); });
$('#addAndroidCalendar').addEventListener('click', async event => { await addAndroidCalendar(event); $('#calendarDialog').close(); });
$('#closeCalendarDialog').addEventListener('click', () => $('#calendarDialog').close());
$('#calendarDialog').addEventListener('click', event => { if (event.target === $('#calendarDialog')) $('#calendarDialog').close(); });
window.addEventListener('offline', () => setBookingStatus('offline', 'Нет соединения с интернетом'));
window.addEventListener('online', loadServices);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void registerBookingPageVisit({ force:true }); });
const publicGroupBookingsController = window.MinutaGroupBookings?.createPublicController ? window.MinutaGroupBookings.createPublicController({
  db, $, escapeHtml, getSlug:() => requestedOrganizationSlug,
  getRequestedEventId:() => requestedGroupId,
  onRequestedEventUnavailable:() => {
    if (!requestedGroupId) return;
    rejectRequestedBookingLink('Групповое событие завершено, заполнено или больше не опубликовано.');
  }
}) : { bind() {}, load() {} };
publicGroupBookingsController.bind();
restoreClientContact();
applyClientPagePresentation();
renderDates();
renderTimes();
void loadServices().then(valid => { if (valid) publicGroupBookingsController.load(); });
updateSubmitAvailability();
