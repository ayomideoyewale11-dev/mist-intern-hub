describe('production email configuration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  it('does not report a dry-run email as delivered in production', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.BREVO_API_KEY;
    delete process.env.BREVO_SENDER_EMAIL;
    jest.resetModules();
    const mailer = require('../config/mailer');
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(mailer.sendPasswordResetEmail({ email: 'user@example.com', name: 'User' }, 'token'))
        .resolves.toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});

describe('production app URL configuration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  it('refuses to load the production app without a public HTTPS APP_URL', () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'test-secret';
    delete process.env.APP_URL;
    jest.resetModules();
    expect(() => require('../app')).toThrow(/APP_URL must be a public HTTPS URL in production/);
  });

  it.each(['http://mist.example.com', 'https://localhost', 'https://127.0.0.1', 'https://mist.example.com/path?token=x', 'https://mist.local', 'https://mist.invalid', 'https://mist.test', 'https://mist.example', 'https://mist.internal'])('refuses an unsafe production APP_URL: %s', (url) => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'test-secret';
    process.env.APP_URL = url;
    jest.resetModules();
    expect(() => require('../app')).toThrow(/APP_URL must be a public HTTPS URL in production/);
  });

  it('accepts a public HTTPS APP_URL', () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'test-secret';
    process.env.APP_URL = 'https://interns.example.com';
    jest.resetModules();
    expect(() => require('../app')).not.toThrow();
  });
});
