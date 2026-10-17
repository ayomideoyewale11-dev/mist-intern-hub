// Reads the CSRF token the server put in a <meta> tag (see views/layout.pug)
function getCsrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.content;
}

// Shared fetch wrapper: redirects to login on a 401, throws on any other
// error, and automatically attaches the CSRF token on any request that
// isn't a plain GET — every page script gets this for free, no changes
// needed at each call site.
async function api(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    options.headers = { ...options.headers, 'X-CSRF-Token': getCsrfToken() };
  }
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Session expired.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
