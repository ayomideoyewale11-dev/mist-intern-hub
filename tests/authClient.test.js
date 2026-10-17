const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/authClient.js'), 'utf8');

function loadClient(fetchImpl) {
  const notices = [];
  const storage = new Map();
  const logoutListeners = {};
  const logoutButton = {
    addEventListener: (name, handler) => { logoutListeners[name] = handler; },
  };
  const context = {
    document: {
      getElementById: (id) => id === 'logout-btn' ? logoutButton : null,
      querySelector: () => ({ content: 'csrf-token' }),
      createElement: () => ({ setAttribute() {}, textContent: '' }),
      body: { prepend: (message) => notices.push(message) },
      addEventListener() {},
    },
    window: { location: { pathname: '/tasks/123', search: '?view=mine', href: '' } },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    fetch: fetchImpl,
    setTimeout,
    Promise,
  };
  vm.runInNewContext(source, context);
  return { context, notices, storage, logoutListeners };
}

describe('auth client fresh-tab guard', () => {
  it('stays on the page and reports a connection failure instead of redirecting unconditionally', async () => {
    const { context, notices } = loadClient(() => Promise.reject(new Error('offline')));

    expect(context.tabGuard()).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));

    expect(context.window.location.href).toBe('');
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent).toMatch(/connection problem/i);
  });

  it('redirects after the logout request succeeds', async () => {
    const { context } = loadClient(() => Promise.resolve({ ok: true }));

    context.tabGuard();
    await new Promise((resolve) => setImmediate(resolve));

    expect(context.window.location.href).toBe('/');
  });

  it('does not redirect after the logout request fails and reports the failure', async () => {
    const { context, notices, logoutListeners } = loadClient(() => Promise.resolve({ ok: false }));

    context.bindLogout();
    await logoutListeners.click();

    expect(context.window.location.href).toBe('');
    expect(notices).toHaveLength(1);
    expect(notices[0].textContent).toMatch(/could not log out/i);
  });

  it('does not redirect when the logout request cannot reach the server', async () => {
    const { context, notices, logoutListeners } = loadClient(() => Promise.reject(new Error('offline')));

    context.bindLogout();
    await logoutListeners.click();

    expect(context.window.location.href).toBe('');
    expect(notices).toHaveLength(1);
  });
});
