// Filter panel is a floating popover on desktop/tablet and a full-screen
// filter page on phones.
(function () {
  const toggle = document.querySelector('.audit-filter-toggle');
  const toolbar = document.querySelector('.audit-toolbar-row');
  const panel = document.getElementById('audit-filter-panel');
  const close = document.querySelector('.audit-filter-close');
  if (!toggle || !toolbar || !panel) return;

  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('is-audit-filter-open', open);
    if (open) {
      const firstInput = panel.querySelector('select, input');
      (window.matchMedia('(max-width: 767px)').matches ? close : firstInput)?.focus();
    } else {
      toggle.focus();
    }
  }

  toggle.addEventListener('click', () => setOpen(panel.hidden));
  close?.addEventListener('click', () => setOpen(false));
  document.addEventListener('click', (event) => {
    if (!panel.hidden && !toolbar.contains(event.target)) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (panel.hidden) return;
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'Tab' && window.matchMedia('(max-width: 767px)').matches) {
      const focusable = [...panel.querySelectorAll('button, a[href], select, input')]
        .filter((element) => !element.disabled && element.getClientRects().length);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
})();
