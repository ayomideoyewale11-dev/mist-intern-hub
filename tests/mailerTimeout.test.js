describe('mail provider timeout', () => {
  const originalEnv = { ...process.env };
  const originalFetch = global.fetch;

  afterEach(() => {
    jest.useRealTimers();
    jest.resetModules();
    process.env = { ...originalEnv };
    global.fetch = originalFetch;
  });

  it('aborts a provider request that does not complete within the timeout', async () => {
    jest.useFakeTimers();
    process.env.BREVO_API_KEY = 'test-key';
    process.env.BREVO_SENDER_EMAIL = 'sender@example.com';
    jest.resetModules();
    const fetchMock = jest.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    global.fetch = fetchMock;
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mailer = require('../config/mailer');
    try {
      const pending = mailer.sendPasswordResetEmail({ email: 'user@example.com', name: 'User' }, 'token');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toBe(false);
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    } finally {
      error.mockRestore();
    }
  });
});
