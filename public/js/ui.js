// In-page replacements for the browser's alert() and confirm() pop-ups, so
// messages look like the rest of the app.
//   uiConfirm(message, { title, confirmText, danger })  -> Promise<boolean>
//   uiToast(message, 'ok' | 'error')                     -> shows a short message
//   uiFlash(message)  -> shows a toast on the NEXT page load (for redirects / reloads)
(function () {
  const FLASH_KEY = 'mist-flash';

  function uiToast(message, tone) {
    let box = document.getElementById('ui-toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'ui-toasts';
      box.className = 'ui-toasts';
      box.setAttribute('role', 'status');
      box.setAttribute('aria-live', 'polite');
      document.body.appendChild(box);
    }
    const t = document.createElement('div');
    t.className = 'ui-toast' + (tone === 'error' ? ' is-error' : '');
    t.textContent = message;
    box.appendChild(t);
    setTimeout(() => t.remove(), tone === 'error' ? 7000 : 4500);
  }

  function uiFlash(message) {
    try { sessionStorage.setItem(FLASH_KEY, message); } catch (e) { /* storage unavailable: skip */ }
  }

  function uiConfirm(message, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      const dlg = document.createElement('dialog');
      dlg.className = 'ui-dialog';
      dlg.setAttribute('aria-labelledby', 'ui-dialog-title');

      const title = document.createElement('h2');
      title.id = 'ui-dialog-title';
      title.textContent = o.title || 'Are you sure?';
      const text = document.createElement('p');
      text.textContent = message;

      const row = document.createElement('div');
      row.className = 'ui-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'ui-btn';
      cancel.textContent = 'Cancel';
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'ui-btn ui-btn-main' + (o.danger ? ' is-danger' : '');
      ok.textContent = o.confirmText || 'Continue';
      row.append(cancel, ok);
      dlg.append(title, text, row);
      document.body.appendChild(dlg);

      let answer = false;
      const finish = (value) => { answer = value; dlg.close(); };
      cancel.addEventListener('click', () => finish(false));
      ok.addEventListener('click', () => finish(true));
      dlg.addEventListener('click', (e) => { if (e.target === dlg) finish(false); }); // click on the backdrop
      dlg.addEventListener('close', () => { dlg.remove(); resolve(answer); }); // also runs on Escape
      dlg.showModal();
      cancel.focus(); // the safe choice is focused first
    });
  }

  window.uiToast = uiToast;
  window.uiFlash = uiFlash;
  window.uiConfirm = uiConfirm;

  document.addEventListener('DOMContentLoaded', () => {
    try {
      const msg = sessionStorage.getItem(FLASH_KEY);
      if (msg) { sessionStorage.removeItem(FLASH_KEY); uiToast(msg, 'ok'); }
    } catch (e) { /* ignore */ }
  });
})();
