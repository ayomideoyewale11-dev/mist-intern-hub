function bindNewInternForm() {
  const form = document.getElementById('new-intern-form');
  const status = document.getElementById('intern-form-status');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = 'Registering…';
    status.removeAttribute('data-state');
    try {
      const created = await api('/api/auth/create-intern', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: document.getElementById('internName').value,
          email: document.getElementById('internEmail').value,
          internshipStartDate: document.getElementById('internStartDate').value,
          internshipEndDate: document.getElementById('internEndDate').value,
        }),
      });
      status.textContent = created.emailSent
        ? 'Intern registered. They\u2019ll get an email to set their password. Taking you to the Interns page…'
        : 'Intern registered, but the welcome email could not be sent. Use Resend welcome from the Interns page.';
      status.dataset.state = created.emailSent ? 'ok' : 'error';
      form.reset();
      if (created.emailSent) setTimeout(() => { window.location.href = '/interns'; }, 1500);
    } catch (err) {
      status.textContent = err.message;
      status.dataset.state = 'error';
    }
  });
}

bindNewInternForm();
