// Opens and closes the header menu (views/partials/hubHeader.pug).
// Click the button to toggle; click anywhere else or press Escape to close.
(function () {
  const btn = document.getElementById('menu-btn');
  const menu = document.getElementById('site-menu');
  if (!btn || !menu) return;
  const label = btn.querySelector('.hh-toggle-label');

  function setOpen(open) {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('is-open', open);
    if (label) label.textContent = open ? 'Close' : 'Menu';
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation(); // so the document click below doesn't close it again
    setOpen(menu.hidden);
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) { setOpen(false); btn.focus(); }
  });
})();
