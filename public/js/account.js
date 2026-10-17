document.getElementById('change-password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const status = document.getElementById('form-status');
  status.removeAttribute('data-state');
  status.textContent = 'Saving…';
  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: form.currentPassword.value,
        newPassword: form.newPassword.value,
      }),
    });
    status.textContent = 'Password changed.';
    status.dataset.state = 'ok';
    form.reset();
  } catch (err) {
    status.textContent = err.message;
    status.dataset.state = 'error';
  }
});
