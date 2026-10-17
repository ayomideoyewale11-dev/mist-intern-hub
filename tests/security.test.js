const request = require('supertest');
const { setupTestApp, teardownTestApp, clearDatabase } = require('./testApp');
const { makeAdmin, makeIntern, getCsrfToken } = require('./helpers');
const { maskSecrets } = require('../middleware/security');

let app;
beforeAll(async () => { app = await setupTestApp(); }, 30000);
afterEach(clearDatabase);
afterAll(teardownTestApp);

describe('Query-operator injection', () => {
  it('returns validation errors instead of crashing when a request has no parsed body', async () => {
    const agent = request.agent(app);
    const csrf = await getCsrfToken(agent);
    const res = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('refuses a login body that uses a Mongo operator instead of text', async () => {
    const agent = request.agent(app);
    const csrf = await getCsrfToken(agent);
    const res = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf)
      .send({ email: { $ne: '' }, password: { $ne: '' } });
    expect(res.status).toBe(400);
  });

  it('refuses operator keys nested anywhere in a body', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const res = await agent.post('/api/tasks').set('X-CSRF-Token', csrfToken)
      .send({ title: 't', description: 'd', dueDate: '2099-01-01', assignedTo: { $gt: '' } });
    expect(res.status).toBe(400);
    const res2 = await agent.post('/api/tasks').set('X-CSRF-Token', csrfToken)
      .send({ title: 't', description: 'd', dueDate: '2099-01-01', extra: { 'a.b': 1 } });
    expect(res2.status).toBe(400);
  });

  it('forgot-password with a non-text email answers 400, not a crash', async () => {
    const agent = request.agent(app);
    const csrf = await getCsrfToken(agent);
    const res = await agent.post('/api/auth/forgot-password').set('X-CSRF-Token', csrf).send({ email: ['a@b.com'] });
    expect(res.status).toBe(400);
  });
});

describe('Login guessing', () => {
  it('stops guessing one account after 10 wrong passwords, and still lets others in', async () => {
    const { user } = await makeIntern(app, { email: 'target@test.com' });
    const agent = request.agent(app);
    const csrf = await getCsrfToken(agent);
    const guess = (email, password) => agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ email, password });
    let last;
    for (let i = 0; i < 10; i++) { last = await guess('target@test.com', 'WrongPassword1'); expect(last.status).toBe(401); }
    last = await guess('target@test.com', 'WrongPassword1');
    expect(last.status).toBe(429);
    expect(last.body.error).toMatch(/Too many failed attempts/);
    // another account is not affected
    await makeIntern(app, { email: 'other@test.com' });
    expect((await guess('other@test.com', 'WrongPassword1')).status).toBe(401);
    expect(user.email).toBe('target@test.com');
  });
});

describe('Private pages are not cached', () => {
  it('sends Cache-Control: no-store on pages and API answers', async () => {
    const { agent } = await makeAdmin(app);
    expect((await agent.get('/admin')).headers['cache-control']).toBe('no-store');
    expect((await agent.get('/api/auth/me')).headers['cache-control']).toBe('no-store');
  });
});

describe('Security headers', () => {
  it('sets a strict content-security policy and hides the framework', async () => {
    const res = await request(app).get('/login');
    expect(res.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect(res.headers['content-security-policy']).toMatch(/object-src 'none'/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('Logs', () => {
  it('hides a password-reset token in logged addresses', () => {
    expect(maskSecrets('/reset-password/abc123secret')).toBe('/reset-password/[hidden]');
    expect(maskSecrets('/archive?q=x')).toBe('/archive?q=x');
  });

  it('hides a password-reset token in Morgan referrer logs', () => {
    const morgan = require('morgan');
    const referrer = morgan.referrer(
      { headers: { referer: 'https://example.com/reset-password/abc123secret' } },
      {},
    );

    expect(referrer).toBe('https://example.com/reset-password/[hidden]');
  });
});
