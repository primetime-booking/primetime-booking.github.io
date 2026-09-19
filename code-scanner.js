(function initMinutaCodeScanner(global) {
  'use strict';

  const formats = ['qr_code','code_128','code_39','codabar','ean_13','ean_8','upc_a','upc_e','itf'];
  let detector = null;
  let stream = null;
  let frameHandle = 0;
  let cameraGeneration = 0;
  let activeButton = null;
  const $ = selector => document.querySelector(selector);
  const dialog = () => $('#codeScannerDialog');
  const video = () => $('#codeScannerVideo');
  const status = () => $('#codeScannerStatus');

  function cleanCode(value) {
    return String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160);
  }
  function stopCamera() {
    cameraGeneration += 1;
    if (frameHandle) cancelAnimationFrame(frameHandle);
    frameHandle = 0;
    stream?.getTracks?.().forEach(track => track.stop());
    stream = null;
    const element = video();
    if (element) element.srcObject = null;
  }
  function matchOption(select, code) {
    const needle = cleanCode(code).toLocaleLowerCase('ru-RU');
    const option = [...select.options].find(item => {
      const codes = [item.dataset.code, item.dataset.sku].map(value => cleanCode(value).toLocaleLowerCase('ru-RU')).filter(Boolean);
      return codes.length ? codes.includes(needle) : cleanCode(item.textContent).toLocaleLowerCase('ru-RU') === needle;
    });
    if (!option) return false;
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles:true }));
    return true;
  }
  function applyCode(rawCode) {
    const cleaned = cleanCode(rawCode);
    if (!cleaned || !activeButton) return false;
    const target = document.getElementById(activeButton.dataset.codeScanTarget || '');
    if (!target) return false;
    const maximum = Number(target.maxLength) > 0 ? Number(target.maxLength) : 160;
    if (cleaned.length > maximum) { status().textContent = `Код длиннее допустимых ${maximum} символов.`; return false; }
    const code = cleaned;
    if (activeButton.dataset.codeScanMatch === 'option' && target.tagName === 'SELECT') {
      if (!matchOption(target, code)) { status().textContent = 'Код считан, но такой позиции в текущем списке нет.'; return false; }
    } else {
      target.value = code;
      target.dispatchEvent(new Event('input', { bubbles:true }));
      target.dispatchEvent(new Event('change', { bubbles:true }));
    }
    if (activeButton.dataset.codeScanPreset === 'sale') {
      const kind = $('#inventoryMovementKind'), quantity = $('#inventoryMovementQuantity'), reason = $('#inventoryMovementReason');
      if (kind) { kind.value = 'write_off'; kind.dispatchEvent(new Event('change', { bubbles:true })); }
      if (quantity && !quantity.value) quantity.value = '1';
      if (reason && !reason.value) reason.value = 'Продажа';
    }
    document.dispatchEvent(new CustomEvent('minuta:code-scanned', { detail:{ code, targetId:target.id, mode:activeButton.dataset.codeScanMode || '' } }));
    stopCamera();
    dialog()?.close();
    target.focus({ preventScroll:true });
    return true;
  }
  async function scanFrame() {
    const element = video();
    if (!stream || !detector || !element || dialog()?.open !== true) return;
    if (element.readyState >= 2) {
      try { const codes = await detector.detect(element); if (codes?.[0]?.rawValue && applyCode(codes[0].rawValue)) return; } catch {}
    }
    frameHandle = requestAnimationFrame(scanFrame);
  }
  async function startCamera() {
    stopCamera();
    const generation = cameraGeneration;
    const state = status();
    if (!global.isSecureContext || !navigator.mediaDevices?.getUserMedia) { state.textContent = 'Камера недоступна в этом браузере. Введите код вручную.'; return; }
    if (!('BarcodeDetector' in global)) { state.textContent = 'Браузер не поддерживает распознавание кодов камерой. Введите код вручную.'; return; }
    try {
      const supported = typeof BarcodeDetector.getSupportedFormats === 'function' ? await BarcodeDetector.getSupportedFormats() : formats;
      if (generation !== cameraGeneration || dialog()?.open !== true) return;
      detector = new BarcodeDetector({ formats:formats.filter(format => supported.includes(format)) });
      const acquired = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:{ ideal:'environment' }, width:{ ideal:1280 }, height:{ ideal:720 } }, audio:false });
      if (generation !== cameraGeneration || dialog()?.open !== true) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired;
      video().srcObject = stream;
      await video().play();
      if (generation !== cameraGeneration || dialog()?.open !== true) { stopCamera(); return; }
      state.textContent = 'Наведите камеру на QR-код или штрихкод.';
      frameHandle = requestAnimationFrame(scanFrame);
    } catch (error) {
      if (generation !== cameraGeneration) return;
      stopCamera();
      state.textContent = error?.name === 'NotAllowedError' ? 'Доступ к камере не разрешён. Разрешите его в настройках сайта или введите код вручную.' : 'Не удалось включить камеру. Введите код вручную.';
    }
  }
  function open(button) {
    const root = dialog();
    if (!root) return;
    activeButton = button;
    $('#codeScannerTitle').textContent = button.dataset.codeScanTitle || 'Сканировать код';
    $('#codeScannerManual').value = '';
    status().textContent = 'Камера включится только для этого сканирования.';
    root.showModal();
    void startCamera();
  }
  function bind() {
    document.addEventListener('click', event => {
      const opener = event.target.closest('[data-code-scan-target]');
      if (opener) { event.preventDefault(); open(opener); return; }
      if (event.target.closest('[data-close-code-scanner]')) { stopCamera(); dialog()?.close(); }
    });
    $('#codeScannerManualForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const holder = status(), previous = holder.textContent;
      if (!applyCode($('#codeScannerManual').value) && holder.textContent === previous) holder.textContent = 'Введите код или повторите сканирование.';
    });
    dialog()?.addEventListener('close', stopCamera);
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
  }
  global.MinutaCodeScanner = Object.freeze({ bind, cleanCode });
  bind();
})(window);
