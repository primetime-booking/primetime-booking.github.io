(function () {
  'use strict';

  const config = window.MINUTA_CONFIG || {};

  function digits(value) {
    let result = String(value || '').replace(/\D/g, '').slice(0, 11);
    if (result.length === 10) result = `7${result}`;
    if (result[0] === '8') result = `7${result.slice(1)}`;
    return result;
  }

  function formatPhone(value) {
    const valueDigits = digits(value);
    if (!valueDigits) return '';
    const local = valueDigits.slice(1);
    return `+7${local.length ? ` (${local.slice(0, 3)}` : ''}${local.length >= 3 ? ')' : ''}${local.length > 3 ? ` ${local.slice(3, 6)}` : ''}${local.length > 6 ? `-${local.slice(6, 8)}` : ''}${local.length > 8 ? `-${local.slice(8, 10)}` : ''}`;
  }

  function toE164(value) {
    const valueDigits = digits(value);
    if (!/^7\d{10}$/.test(valueDigits)) throw new Error('invalid_phone');
    return `+${valueDigits}`;
  }

  function formatCode(value) {
    return String(value || '').replace(/\D/g, '').slice(0, 6);
  }

  async function capability() {
    if (!config.supabaseUrl || !config.supabaseKey || !navigator.onLine) return { enabled:false, reason:navigator.onLine ? 'unavailable' : 'offline' };
    try {
      const response = await fetch(`${config.supabaseUrl}/auth/v1/settings`, {
        headers: { apikey:config.supabaseKey },
        cache:'no-store',
        referrerPolicy:'no-referrer'
      });
      if (!response.ok) return { enabled:false, reason:'unavailable' };
      const settings = await response.json();
      if (settings?.external?.phone !== true) return { enabled:false, reason:'disabled' };
      const backend = await fetch(`${config.supabaseUrl}/rest/v1/rpc/get_minuta_phone_auth_capability`, {
        method:'POST',
        headers: { apikey:config.supabaseKey, authorization:`Bearer ${config.supabaseKey}`, 'content-type':'application/json' },
        body:'{}',
        cache:'no-store',
        referrerPolicy:'no-referrer'
      });
      if (!backend.ok || await backend.json() !== true) return { enabled:false, reason:'backend' };
      return { enabled:true, reason:'' };
    } catch {
      return { enabled:false, reason:'unavailable' };
    }
  }

  function message(error, action = 'request') {
    const raw = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
    if (/invalid_phone|phone.*invalid/.test(raw)) return 'Введите полный номер телефона.';
    if (/over_request_rate_limit|rate limit|too many/.test(raw)) return 'Код уже отправлялся. Подождите минуту и повторите.';
    if (/otp_expired|token.*expired/.test(raw)) return 'Срок действия кода истёк. Запросите новый.';
    if (/invalid.*otp|token.*invalid|otp.*invalid/.test(raw)) return 'Неверный код. Проверьте SMS и попробуйте ещё раз.';
    if (/signup.*disabled|user.*not found/.test(raw)) return 'Не удалось отправить код для входа. Проверьте номер или войдите по email.';
    if (/phone provider.*disabled|unsupported.*phone/.test(raw)) return 'Вход по SMS пока не подключён.';
    if (!navigator.onLine) return 'Нет соединения с интернетом.';
    return action === 'verify' ? 'Не удалось проверить код. Попробуйте ещё раз.' : 'Не удалось отправить SMS. Попробуйте ещё раз.';
  }

  async function request(db, value, options = {}) {
    const phone = toE164(value);
    const result = await db.auth.signInWithOtp({
      phone,
      options: {
        shouldCreateUser:options.shouldCreateUser === true,
        ...(options.data ? { data:options.data } : {})
      }
    });
    if (result.error) throw result.error;
    return phone;
  }

  async function verify(db, phone, token, type = 'sms') {
    const cleanToken = formatCode(token);
    if (cleanToken.length !== 6) throw new Error('invalid_otp');
    const result = await db.auth.verifyOtp({ phone:toE164(phone), token:cleanToken, type });
    if (result.error) throw result.error;
    return result.data;
  }

  window.MinutaPhoneAuth = Object.freeze({ capability, digits, formatCode, formatPhone, message, request, toE164, verify });
})();
