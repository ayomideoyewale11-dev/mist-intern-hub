// The intern dropdown is already filled with real data by the server
// (see routes/viewRoutes.js), so nothing needs to fetch it here. To
// register a new intern, see views/registerIntern.pug / registerIntern.js
// instead — that's its own page now, reached via the link on this one.
function bindNewTaskForm() {
  const form = document.getElementById('new-task-form');
  const status = document.getElementById('form-status');
  // The date picker greys out days before today (the server refuses them as well)
  document.getElementById('dueDate').min = document.querySelector('meta[name="app-date"]').content;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.removeAttribute('data-state');
    const picked = [...document.querySelectorAll('input[name="intern"]:checked')].map((box) => box.value);
    if (!picked.length) {
      status.textContent = document.querySelector('.pick-row') ? 'Choose at least one intern.' : 'You have no interns yet. Register one from the Interns page.';
      status.dataset.state = 'error';
      return;
    }
    status.textContent = 'Assigning…';
    try {
      const created = await api('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: document.getElementById('title').value,
          description: document.getElementById('description').value,
          dueDate: document.getElementById('dueDate').value,
          assignedTo: picked,
        }),
      });
      uiFlash(created.count ? `Task assigned to ${created.count} interns.` : 'Task assigned.');
      window.location.href = '/archive'; // that's the only place it can be seen now
    } catch (err) {
      status.textContent = err.message;
      status.dataset.state = 'error';
    }
  });
}

// The "Assign to" picker: a button that opens a searchable list of checkboxes, so it
// stays small however many interns there are.
function bindInternPicker() {
  const btn = document.getElementById('pick-btn');
  if (!btn) return;
  const panel = document.getElementById('pick-panel');
  const summary = document.getElementById('pick-summary');
  const field = btn.closest('.pick');
  const search = document.getElementById('pick-search'); // these four only exist when there are interns
  const count = document.getElementById('pick-count');
  const none = document.getElementById('pick-none');
  const done = document.getElementById('pick-done');
  const rows = [...document.querySelectorAll('.pick-row')];
  const boxes = rows.map((r) => r.querySelector('input'));

  function refresh() {
    const chosen = rows.filter((r, i) => boxes[i].checked);
    const n = chosen.length;
    count.textContent = `${n} of ${rows.length} selected`;
    if (n === 0) summary.textContent = 'Choose interns…';
    else if (n === rows.length && n > 2) summary.textContent = `All ${n} interns`;
    else if (n <= 2) summary.textContent = chosen.map((r) => r.dataset.name).join(', ');
    else summary.textContent = `${n} interns selected`;
  }
  function setOpen(open) {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('is-open', open);
    if (open && search) search.focus();
  }

  btn.addEventListener('click', () => setOpen(panel.hidden));
  if (done) done.addEventListener('click', () => { setOpen(false); btn.focus(); });
  document.addEventListener('click', (e) => { if (!panel.hidden && !field.contains(e.target)) setOpen(false); });
  field.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { setOpen(false); btn.focus(); } });

  if (!rows.length) return; // no interns: the panel only shows "You have no interns yet."
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); }); // don't submit the form
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    rows.forEach((r) => { r.hidden = !r.dataset.search.includes(q); if (!r.hidden) shown++; });
    none.hidden = shown > 0;
  });

  document.getElementById('pick-all').addEventListener('click', () => {
    rows.forEach((r, i) => { if (!r.hidden) boxes[i].checked = true; }); // only the ones shown by the search
    refresh();
  });
  document.getElementById('pick-clear').addEventListener('click', () => { boxes.forEach((b) => { b.checked = false; }); refresh(); });
  boxes.forEach((b) => b.addEventListener('change', refresh));
  refresh();
}

bindNewTaskForm();
bindInternPicker();
