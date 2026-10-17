const MAX_FILE_MB = 2; // keep in sync with routes/taskRoutes.js

// Where to go after saving feedback or deleting: the page this task was opened
// from (?back=...), if it is one of our own supervisor pages, else the Archive.
function backAddress() {
  const back = new URLSearchParams(window.location.search).get('back') || '';
  return /^\/(admin|audit-log|archive|interns|alumni)(\/[a-f0-9]{24})?([?#][\w=&%.+~#-]*)?$/.test(back) ? back : '/archive';
}

// Edit title / description / due date (also how an overdue task gets extended)
document.getElementById('edit-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    await api(`/api/tasks/${form.dataset.taskId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: form.elements.namedItem('title').value,
        description: form.elements.namedItem('description').value,
        dueDate: form.elements.namedItem('dueDate').value,
      }),
    });
    uiFlash('Task updated.');
    window.location.reload();
  } catch (err) {
    uiToast(err.message, 'error');
  }
});

// Extend the due date for every still-open/overdue copy of an "assign to all" task
document.getElementById('batch-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const result = await api(`/api/tasks/batch/${form.dataset.batchId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dueDate: form.dueDate.value }),
    });
    uiFlash(`Extended ${result.count} task(s).`);
    window.location.reload();
  } catch (err) {
    uiToast(err.message, 'error');
  }
});

// Leave or update feedback on a submitted task
document.getElementById('feedback-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const status = document.getElementById('feedback-status');
  status.removeAttribute('data-state');
  status.textContent = 'Saving…';
  try {
    await api(`/api/tasks/${form.dataset.taskId}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: form.text.value }),
    });
    uiFlash('Feedback saved.');
    window.location.href = backAddress();
  } catch (err) {
    status.textContent = err.message;
    status.dataset.state = 'error';
  }
});

// Delete — only ever shown for an open task
document.getElementById('delete-btn')?.addEventListener('click', async (e) => {
  const sure = await uiConfirm('This deletes the task permanently. Nothing has been submitted yet, so nothing is kept.', {
    title: 'Delete this task?', confirmText: 'Delete task', danger: true,
  });
  if (!sure) return;
  const id = e.target.dataset.taskId;
  try {
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
    uiFlash('Task deleted.');
    window.location.href = backAddress();
  } catch (err) {
    uiToast(err.message, 'error');
  }
});

// Submit work — only ever shown to the assigned intern, on an open task
document.getElementById('submit-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const status = form.querySelector('.form-status');
  const fileInput = form.querySelector('input[type="file"]');
  status.removeAttribute('data-state');

  if (fileInput.files[0] && fileInput.files[0].size > MAX_FILE_MB * 1024 * 1024) {
    status.textContent = `That file is too large (${MAX_FILE_MB} MB max).`;
    status.dataset.state = 'error';
    return;
  }
  const sure = await uiConfirm('You can only submit once and cannot change it afterwards.', { title: 'Submit your work?', confirmText: 'Submit' });
  if (!sure) return;

  const btn = form.querySelector('button');
  btn.disabled = true;
  status.textContent = 'Submitting…';
  try {
    await api(`/api/tasks/${form.dataset.taskId}/submission`, { method: 'POST', body: new FormData(form) });
    uiFlash('Your work was submitted.');
    window.location.href = '/intern'; // the task no longer belongs on this page either
  } catch (err) {
    status.textContent = err.message;
    status.dataset.state = 'error';
    btn.disabled = false;
  }
});

// Send a submitted task back for a new version (supervisor)
const reopenForm = document.getElementById('reopen-form');
if (reopenForm) {
  reopenForm.dueDate.min = document.querySelector('meta[name="app-date"]').content;
  reopenForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = document.getElementById('reopen-status');
    status.removeAttribute('data-state');
    const sure = await uiConfirm('The current submission is kept as an earlier attempt and the intern is emailed.', {
      title: 'Send this task back?', confirmText: 'Send back',
    });
    if (!sure) return;
    status.textContent = 'Sending…';
    try {
      await api(`/api/tasks/${reopenForm.dataset.taskId}/reopen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reopenForm.reason.value, dueDate: reopenForm.dueDate.value }),
      });
      uiFlash('Sent back to the intern.');
      window.location.reload();
    } catch (err) {
      status.textContent = err.message;
      status.dataset.state = 'error';
    }
  });
}
