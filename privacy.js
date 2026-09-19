const VISITOR_PRESENCE_OPT_OUT_KEY = 'minuta-visitor-presence-opt-out-v1';
const visitorPresenceToggle = document.querySelector('#visitorPresenceToggle');
const visitorPresenceState = document.querySelector('#visitorPresenceState');

function visitorPresenceDisabled() {
  try { return localStorage.getItem(VISITOR_PRESENCE_OPT_OUT_KEY) === '1'; }
  catch { return false; }
}

function renderVisitorPresenceChoice() {
  const disabled = visitorPresenceDisabled();
  visitorPresenceToggle.textContent = disabled ? 'Разрешить учёт посещений' : 'Отключить учёт посещений';
  visitorPresenceToggle.setAttribute('aria-pressed', String(disabled));
  visitorPresenceState.textContent = disabled
    ? 'Учёт посещений отключён в этом браузере.'
    : 'Учёт посещений разрешён в этом браузере.';
}

visitorPresenceToggle?.addEventListener('click', () => {
  try {
    if (visitorPresenceDisabled()) localStorage.removeItem(VISITOR_PRESENCE_OPT_OUT_KEY);
    else {
      localStorage.setItem(VISITOR_PRESENCE_OPT_OUT_KEY, '1');
      Object.keys(localStorage).filter(key => key.startsWith('minuta-visitor-first-source-v1:')).forEach(key => localStorage.removeItem(key));
      Object.keys(sessionStorage).filter(key => key.startsWith('minuta-visitor-presence-v1:') || key.startsWith('minuta-visitor-source-v1:')).forEach(key => sessionStorage.removeItem(key));
    }
  } catch {}
  renderVisitorPresenceChoice();
});

if (visitorPresenceToggle && visitorPresenceState) renderVisitorPresenceChoice();
