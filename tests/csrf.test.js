const request = require('supertest');
const { setupTestApp, teardownTestApp, clearDatabase } = require('./testApp');
const { getCsrfToken } = require('./helpers');

let app;
beforeAll(async () => { app = await setupTestApp(); }, 30000);
afterEach(clearDatabase);
afterAll(teardownTestApp);

describe('CSRF protection', () => {
  it('allows a GET request through with no token at all', async () => {
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
  });

  it('rejects a POST with no X-CSRF-Token header', async () => {
    const agent = request.agent(app);
    await getCsrfToken(agent); // cookie exists, just never sent as a header
    const res = await agent.post('/api/auth/forgot-password').send({ email: 'a@test.com' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/csrf/i);
  });

  it('rejects a POST whose header does not match the cookie', async () => {
    const agent = request.agent(app);
    await getCsrfToken(agent);
    const res = await agent.post('/api/auth/forgot-password')
      .set('X-CSRF-Token', 'this-does-not-match-the-cookie-at-all')
      .send({ email: 'a@test.com' });
    expect(res.status).toBe(403);
  });

  it('accepts a POST whose header matches the cookie', async () => {
    const agent = request.agent(app);
    const csrfToken = await getCsrfToken(agent);
    const res = await agent.post('/api/auth/forgot-password').set('X-CSRF-Token', csrfToken).send({ email: 'a@test.com' });
    expect(res.status).toBe(200); // the route itself always returns 200, even for an unknown email
  });
});
