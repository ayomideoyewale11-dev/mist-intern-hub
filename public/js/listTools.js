// Submit the search form as soon as a status filter changes.
document.querySelectorAll('select.auto-submit').forEach((sel) => {
  sel.addEventListener('change', () => sel.form.submit());
});

// Search-as-you-type: a small box of matches under the search field, filled
// from /api/suggest while the person is still typing. Pressing Enter (or the
// Search button) still runs the full search as before.
document.querySelectorAll('input[data-suggest]').forEach((input) => {
  const wrap = input.closest('.arch-search');
  const panel = document.createElement('ul');
  panel.className = 'sg-panel';
  panel.id = `sg-${Math.random().toString(36).slice(2, 8)}`;
  panel.setAttribute('role', 'listbox');
  panel.hidden = true;
  wrap.appendChild(panel);
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', panel.id);
  input.setAttribute('aria-expanded', 'false');

  let timer = null;
  let seq = 0;
  let active = -1;

  const rows = () => [...panel.querySelectorAll('.sg-row')];
  function close() {
    panel.hidden = true; active = -1;
    input.setAttribute('aria-expanded', 'false');
  }
  function highlight(i) {
    const r = rows();
    r.forEach((el, n) => el.classList.toggle('is-active', n === i));
    active = i;
  }
  function row(tag, cls) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    const el = document.createElement(tag);
    el.className = `sg-row ${cls || ''}`.trim();
    li.appendChild(el);
    panel.appendChild(li);
    return el;
  }
  function render(items, q) {
    panel.textContent = '';
    active = -1;
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'sg-none';
      li.textContent = 'No matches yet. Press Enter to search.';
      panel.appendChild(li);
    } else {
      items.forEach((it) => {
        const a = row('a');
        a.href = it.url;
        const t = document.createElement('span'); t.className = 'sg-title'; t.textContent = it.label;
        const s = document.createElement('span'); s.className = 'sg-sub'; s.textContent = it.sub;
        a.append(t, s);
      });
      const all = row('button', 'sg-all');
      all.type = 'button';
      all.textContent = `See all results for “${q}”`;
      all.addEventListener('click', () => { close(); input.form.requestSubmit(); });
    }
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  async function load() {
    const q = input.value.trim();
    if (q.length < 2) { seq += 1; close(); return; }
    const mine = ++seq;
    const params = new URLSearchParams({ kind: input.dataset.suggest, q });
    if (input.dataset.intern) params.set('internId', input.dataset.intern);
    try {
      const res = await fetch(`/api/suggest?${params}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!res.ok) { close(); return; }
      const data = await res.json();
      if (mine !== seq) return; // a newer keystroke already replaced this answer
      render(data.items || [], q);
    } catch (e) { if (mine === seq) close(); }
  }

  input.addEventListener('input', () => { seq += 1; clearTimeout(timer); timer = setTimeout(load, 200); });
  input.addEventListener('focus', () => { if (input.value.trim().length >= 2 && panel.hidden) load(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (panel.hidden) return;
    const r = rows();
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(Math.min(r.length - 1, active + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(Math.max(0, active - 1)); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); r[active].click(); }
  });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });
  input.form.addEventListener('submit', () => { seq += 1; });
});
