(function () {
  'use strict';

  const SDK_URL = 'https://telegram.org/js/telegram-widget.js?22';
  const states = new WeakMap();
  let sdkPromise = null;

  function copy(button) {
    return {
      title: button.querySelector('[data-telegram-auth-title]'),
      note: button.querySelector('[data-telegram-auth-note]'),
      icon: button.querySelector('.telegram-connect-arrow use')
    };
  }

  function render(button, mode, title, note) {
    const parts = copy(button);
    button.dataset.telegramAuthState = mode;
    button.classList.toggle('is-connected', mode === 'connected');
    button.setAttribute('aria-pressed', String(mode === 'connected'));
    if (parts.title) parts.title.textContent = title;
    if (parts.note) parts.note.textContent = note;
    if (parts.icon) parts.icon.setAttribute('href', mode === 'connected' ? 'ui-icons.svg#icon-check' : 'ui-icons.svg#icon-arrow-right');
  }

  function loadSdk() {
    if (window.Telegram?.Login?.auth) return Promise.resolve(window.Telegram.Login);
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-minuta-telegram-sdk]');
      const script = existing || document.createElement('script');
      const done = () => window.Telegram?.Login?.auth ? resolve(window.Telegram.Login) : reject(new Error('telegram_sdk_unavailable'));
      script.addEventListener('load', done, { once:true });
      script.addEventListener('error', () => reject(new Error('telegram_sdk_unavailable')), { once:true });
      if (!existing) {
        script.src = SDK_URL;
        script.async = true;
        script.dataset.minutaTelegramSdk = 'true';
        document.head.appendChild(script);
      }
    }).catch(error => {
      sdkPromise = null;
      throw error;
    });
    return sdkPromise;
  }

  async function requestConfig(endpoint, manageToken, apikey) {
    const response = await fetch(`${endpoint}/auth-config?token=${encodeURIComponent(manageToken)}`, {
      headers: { apikey },
      cache: 'no-store'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result?.ok || !/^\d{1,20}$/.test(String(result.bot_id || ''))) throw new Error(result?.error || 'telegram_config_unavailable');
    return result;
  }

  async function saveAuthorization(state, auth) {
    const response = await fetch(`${state.endpoint}/authorize`, {
      method: 'POST',
      headers: { 'content-type':'application/json', apikey:state.apikey },
      body: JSON.stringify({ manage_token:state.manageToken, telegram_auth:auth })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result?.ok || result.connected !== true) throw new Error(result?.error || 'telegram_authorization_failed');
    return result;
  }

  function start(button) {
    const state = states.get(button);
    if (!state || state.pending || state.connected) return;
    if (!state.ready || !window.Telegram?.Login?.auth) {
      void retry(state.options);
      return;
    }
    state.pending = true;
    button.disabled = true;
    render(button, 'authorizing', 'Подтвердите доступ в Telegram', 'Откроется только безопасное окно подтверждения');
    let finished = false;
    const timeout = window.setTimeout(() => {
      if (finished) return;
      state.pending = false;
      button.disabled = false;
      render(button, 'ready', 'Подключить Telegram', 'Разрешите уведомления один раз — запускать бота не нужно');
    }, 60000);

    window.Telegram.Login.auth({ bot_id:state.config.bot_id, request_access:'write', lang:'ru' }, async auth => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      if (!auth) {
        state.pending = false;
        button.disabled = false;
        render(button, 'ready', 'Получать уведомления в Telegram', 'Подтверждение отменено — можно попробовать снова');
        return;
      }
      render(button, 'saving', 'Подключаем уведомления…', 'Проверяем разрешение Telegram');
      try {
        const result = await saveAuthorization(state, auth);
        state.pending = false;
        state.ready = false;
        state.connected = true;
        button.disabled = true;
        render(button, 'connected', 'Telegram подключён', 'Повторять это для следующих записей не придётся');
        state.onConnected?.(result);
      } catch (error) {
        state.pending = false;
        button.disabled = false;
        render(button, 'error', 'Не удалось подключить Telegram', 'Проверьте разрешение и попробуйте ещё раз');
        state.onError?.(error);
      }
    });
  }

  async function prepare({ button, manageToken, endpoint, apikey, onConnected, onError }) {
    if (!button || !/^[0-9a-f-]{36}$/i.test(manageToken || '')) return false;
    const previous = states.get(button);
    if (previous?.manageToken === manageToken && (previous.ready || previous.pending || previous.connected)) return true;

    const options = { button, manageToken, endpoint, apikey, onConnected, onError };
    const state = { ...options, options, ready:false, pending:false, connected:false, config:null };
    states.set(button, state);
    if (!button.dataset.telegramAuthBound) {
      button.addEventListener('click', () => start(button));
      button.dataset.telegramAuthBound = 'true';
    }
    button.hidden = false;
    button.disabled = true;
    render(button, 'loading', 'Готовим Telegram…', 'Проверяем безопасное подключение');
    try {
      const [config] = await Promise.all([requestConfig(endpoint, manageToken, apikey), loadSdk()]);
      if (states.get(button) !== state) return false;
      state.config = config;
      state.connected = config.connected === true;
      if (state.connected) {
        button.disabled = true;
        render(button, 'connected', 'Telegram подключён', 'Повторять это для следующих записей не придётся');
        return true;
      }
      state.ready = true;
      button.disabled = false;
      render(button, 'ready', 'Подключить Telegram', 'Разрешите уведомления один раз — запускать бота не нужно');
      return true;
    } catch (error) {
      if (states.get(button) !== state) return false;
      button.disabled = false;
      render(button, 'error', 'Telegram временно недоступен', 'Нажмите, чтобы повторить подключение');
      state.ready = false;
      state.onError?.(error);
      return false;
    }
  }

  function retry(options) {
    states.delete(options.button);
    return prepare(options);
  }

  window.MinutaTelegramAuth = Object.freeze({ prepare, retry });
})();
