(function enableFastSiteUpdates() {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  const scriptUrl = document.currentScript?.src || location.href;
  const workerUrl = new URL('./sw.js?v=5', scriptUrl).href;
  const CHECK_INTERVAL_MS = 15 * 60 * 1000;
  let registration = null;
  let currentController = navigator.serviceWorker.controller;
  let lastCheck = 0;
  let checkPromise = null;

  function showUpdateNotice() {
    if (document.getElementById('siteUpdateNotice')) return;
    const notice = document.createElement('aside');
    notice.id = 'siteUpdateNotice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.innerHTML = '<span>Доступно обновление интерфейса</span><button type="button">Обновить страницу</button>';
    Object.assign(notice.style, {
      position:'fixed', right:'max(16px, env(safe-area-inset-right))', bottom:'max(16px, env(safe-area-inset-bottom))',
      zIndex:'2147483000', display:'flex', alignItems:'center', gap:'12px', maxWidth:'calc(100vw - 32px)',
      padding:'12px 14px', border:'1px solid rgba(32,42,38,.2)', borderRadius:'14px', background:'#fff',
      color:'#1f2c27', boxShadow:'0 12px 36px rgba(20,28,25,.18)', font:'600 14px/1.35 system-ui,sans-serif'
    });
    const button = notice.querySelector('button');
    Object.assign(button.style, {
      minHeight:'40px', padding:'8px 12px', border:'0', borderRadius:'10px', background:'#24332d',
      color:'#fff', font:'inherit', cursor:'pointer', whiteSpace:'nowrap'
    });
    button.addEventListener('click', () => location.reload());
    document.body.append(notice);
  }

  function checkForUpdate({ force = false, registerOnly = false } = {}) {
    if (checkPromise) return checkPromise;
    const now = Date.now();
    if (!registerOnly && !force && now - lastCheck < CHECK_INTERVAL_MS) return Promise.resolve();
    checkPromise = (async () => {
      try {
        if (!registration) {
          registration = await navigator.serviceWorker.register(workerUrl, { updateViaCache:'none' });
          lastCheck = Date.now();
          if (registerOnly) return;
        }
        if (!registerOnly) {
          lastCheck = Date.now();
          await registration.update();
        }
      } catch {
        // An unavailable update check must not interrupt booking work.
      } finally {
        checkPromise = null;
      }
    })();
    return checkPromise;
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const nextController = navigator.serviceWorker.controller;
    if (currentController && nextController && nextController !== currentController) {
      document.documentElement.dataset.siteUpdateReady = 'true';
      showUpdateNotice();
    }
    currentController = nextController;
  });

  window.addEventListener('load', () => checkForUpdate({ force:true }), { once:true });
  window.addEventListener('online', () => checkForUpdate({ force:true }));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkForUpdate();
  });
  window.setInterval(() => { if (!document.hidden) checkForUpdate(); }, CHECK_INTERVAL_MS);
})();
