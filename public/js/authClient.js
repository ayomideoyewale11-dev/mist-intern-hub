// Duplicated from common.js on purpose — login/register/forgot/reset pages
// don't load common.js, so this stays self-contained here.
function getCsrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.content;
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function goToDashboard(user) {
  let next = null;
  try {
    sessionStorage.setItem('mist-tab', '1');
    next = sessionStorage.getItem('mist-next');
    sessionStorage.removeItem('mist-next');
  } catch (e) {}
  // Come back to the page an email link pointed at (same-site paths only)
  if (next && /^\/(?![\/\\])/.test(next)) { window.location.href = next; return; }
  window.location.href = user.role === 'admin' ? '/admin' : '/intern';
}

function bindForm(formId, url, getPayload, busyText) {
  const form = document.getElementById(formId);
  const status = document.getElementById('form-status');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = busyText;
    status.removeAttribute('data-state');
    try {
      goToDashboard(await postJson(url, getPayload()));
    } catch (err) {
      status.textContent = err.message;
      status.dataset.state = 'error';
    }
  });
}

const val = (id) => document.getElementById(id).value;

function bindLoginForm() {
  bindForm('login-form', '/api/auth/login', () => ({
    email: val('email'), password: val('password'),
  }), 'Logging in…');
}

function bindForgotPasswordForm() {
  const form = document.getElementById('forgot-form');
  const status = document.getElementById('form-status');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = 'Sending…';
    status.removeAttribute('data-state');
    try {
      const data = await postJson('/api/auth/forgot-password', { email: val('email') });
      status.textContent = data.message;
      status.dataset.state = 'ok';
    } catch (err) {
      status.textContent = err.message;
      status.dataset.state = 'error';
    }
  });
}

function bindResetPasswordForm() {
  const form = document.getElementById('reset-form');
  const status = document.getElementById('form-status');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = 'Saving…';
    status.removeAttribute('data-state');
    try {
      await postJson(`/api/auth/reset-password/${form.dataset.token}`, { password: val('password') });
      status.textContent = 'Password changed. Redirecting to log in…';
      status.dataset.state = 'ok';
      setTimeout(() => { window.location.href = '/login'; }, 1500);
    } catch (err) {
      status.textContent = err.message;
      status.dataset.state = 'error';
    }
  });
}

function bindLogout() {
  const btn = document.getElementById('logout-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try { sessionStorage.removeItem('mist-next'); } catch (e) {}
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': getCsrfToken() } });
      if (!response.ok) throw new Error('Session could not be ended.');
      window.location.href = '/login';
    } catch (e) {
      const message = document.createElement('p');
      message.setAttribute('role', 'alert');
      message.textContent = 'Could not log out because of a connection problem. Check your connection and try again.';
      document.body.prepend(message);
    }
  });
}

// Auto-init: each page just needs the form or button that's actually on it.
// requireSession() is gone — the server already enforces login/role before
// it renders a dashboard page at all, so there's nothing left to check here.
// Tab guard: sessionStorage is wiped when a tab is closed. A logged-in page
// (it has the logout button) opened without the marker is a fresh tab, so the
// old login is ended and the visitor lands on the welcome page.
function tabGuard() {
  if (!document.getElementById('logout-btn')) return false;
  let marked = false;
  try { marked = sessionStorage.getItem('mist-tab') === '1'; } catch (e) { return false; }
  if (marked) return false;
  const here = window.location.pathname + window.location.search;
  try { if (!/^\/(admin|intern)?$/.test(window.location.pathname)) sessionStorage.setItem('mist-next', here); } catch (e) {}
  fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': getCsrfToken() } })
    .then((response) => {
      if (!response.ok) throw new Error('Session could not be ended.');
      window.location.href = '/';
    })
    .catch(() => {
      const message = document.createElement('p');
      message.setAttribute('role', 'alert');
      message.textContent = 'Could not end this session because of a connection problem. Check your connection and refresh this page.';
      document.body.prepend(message);
    });
  return true;
}

document.addEventListener('DOMContentLoaded', () => {
  if (tabGuard()) return;
  if (document.getElementById('login-form')) bindLoginForm();
  if (document.getElementById('forgot-form')) bindForgotPasswordForm();
  if (document.getElementById('reset-form')) bindResetPasswordForm();
  bindLogout(); // harmless no-op on pages with no #logout-btn
});
