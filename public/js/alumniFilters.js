// Changing the departure month applies the alumni filter immediately.
(function () {
  const input = document.getElementById('alumni-left-in');
  if (!input || !input.form) return;
  const display = input.parentElement.querySelector('.month-picker-value');
  let lastSubmittedValue = input.value;
  function monthChanged() {
    const value = input.value;
    if (display) display.textContent = value ? `${value.slice(5, 7)}/${value.slice(0, 4)}` : 'mm/yyyy';
    if (value === lastSubmittedValue) return;
    lastSubmittedValue = value;
    if (typeof input.form.requestSubmit === 'function') input.form.requestSubmit();
    else input.form.submit();
  }
  // Clicking anywhere on the box opens the calendar. Before, Chrome only opened it from its own small
  // icon at the far right edge of the invisible field, not from the icon you can see.
  function openCalendar() {
    if (typeof input.showPicker !== 'function') return;
    try { input.showPicker(); } catch { /* not allowed or not supported here: nothing to do */ }
  }
  input.addEventListener('click', openCalendar);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCalendar(); }
  });
  input.addEventListener('input', monthChanged);
  input.addEventListener('change', monthChanged);
})();
