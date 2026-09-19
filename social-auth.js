(function () {
  const FLOW_KEY = 'minuta-social-auth-flow-v1';
  const PROVIDERS = Object.freeze({
    telegram: Object.freeze({ id:'custom:telegram', label:'Telegram' }),
    vk: Object.freeze({ id:'custom:vk', label:'VK ID' }),
    yandex: Object.freeze({ id:'custom:yandex', label:'Яндекс ID' })
  });

  function definition(key) {
    const provider = PROVIDERS[String(key || '').toLowerCase()];
    if (!provider) throw new Error('social_provider_unknown');
    return provider;
  }

  function enabled(key) {
    return window.MINUTA_CONFIG?.socialAuthProviders?.[key] === true;
  }

  function flow() {
    try {
      const value = JSON.parse(sessionStorage.getItem(FLOW_KEY) || 'null');
      if (!value || !PROVIDERS[value.provider] || !['client-login','provider-login','provider-link'].includes(value.mode)) return null;
      if (Date.now() - Number(value.startedAt || 0) > 15 * 60 * 1000) return null;
      return value;
    } catch { return null; }
  }

  function clearFlow() {
    try { sessionStorage.removeItem(FLOW_KEY); } catch {}
  }

  function saveFlow(provider, mode) {
    try { sessionStorage.setItem(FLOW_KEY, JSON.stringify({ provider, mode, startedAt:Date.now() })); } catch {}
  }

  function callbackUrl(page) {
    const url = new URL(page, location.href);
    url.searchParams.set('social_auth', '1');
    return url.href;
  }

  async function start(db, key, mode, page) {
    const provider = definition(key);
    if (!enabled(key)) throw new Error('social_provider_disabled');
    if (!navigator.onLine) throw new Error('social_auth_offline');
    saveFlow(key, mode);
    const options = { redirectTo:callbackUrl(page) };
    const result = mode === 'provider-link'
      ? await db.auth.linkIdentity({ provider:provider.id, options })
      : await db.auth.signInWithOAuth({ provider:provider.id, options });
    if (result.error) {
      clearFlow();
      throw result.error;
    }
    return result.data;
  }

  function render(root = document) {
    root.querySelectorAll('[data-social-auth-provider]').forEach(button => {
      const key = button.dataset.socialAuthProvider;
      const isEnabled = enabled(key);
      button.disabled = !isEnabled;
      button.classList.toggle('is-disabled', !isEnabled);
      button.setAttribute('aria-disabled', String(!isEnabled));
      const state = button.querySelector('[data-social-auth-state]');
      if (state) state.textContent = isEnabled ? '' : 'Не подключён';
    });
  }

  function isLinked(user, key) {
    const id = definition(key).id;
    return Boolean(user?.identities?.some(identity => identity?.provider === id));
  }

  function message(error) {
    const raw = `${error?.message || error || ''}`.toLowerCase();
    if (raw.includes('social_provider_disabled')) return 'Этот способ входа ещё не подключён.';
    if (raw.includes('social_auth_offline')) return 'Для входа через внешний сервис нужен интернет.';
    if (/identity.*already|already.*linked|conflict/.test(raw)) return 'Этот аккаунт уже привязан к другому пользователю.';
    if (/provider.*not.*found|unsupported.*provider/.test(raw)) return 'Провайдер ещё не активирован на сервере.';
    return 'Не удалось выполнить вход. Попробуйте ещё раз.';
  }

  window.MinutaSocialAuth = Object.freeze({ PROVIDERS, enabled, flow, clearFlow, start, render, isLinked, message });
})();
