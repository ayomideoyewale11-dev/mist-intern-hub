const request = require('supertest');
const { setupTestApp, teardownTestApp, clearDatabase } = require('./testApp');
const { makeAdmin, makeIntern } = require('./helpers');
const User = require('../models/User');

let app;
beforeAll(async () => { app = await setupTestApp(); }, 30000);
afterEach(async () => {
  delete process.env.CRON_SECRET;
  await clearDatabase();
});
afterAll(teardownTestApp);

describe('POST /api/cron/daily', () => {
  it('returns 503 when CRON_SECRET is not configured at all', async () => {
    delete process.env.CRON_SECRET;
    const res = await request(app).post('/api/cron/daily').set('X-Cron-Secret', 'anything');
    expect(res.status).toBe(503);
  });

  it('rejects a request with no secret header', async () => {
    process.env.CRON_SECRET = 'correct-secret';
    const res = await request(app).post('/api/cron/daily');
    expect(res.status).toBe(401);
  });

  it('rejects a request with the wrong secret', async () => {
    process.env.CRON_SECRET = 'correct-secret';
    const res = await request(app).post('/api/cron/daily').set('X-Cron-Secret', 'wrong-secret!');
    expect(res.status).toBe(401);
  });

  it('runs the daily job when the secret is correct, with no session or CSRF token', async () => {
    process.env.CRON_SECRET = 'correct-secret';
    // an intern whose internship has already ended — the daily job should deactivate them
    const { user } = await makeIntern(app, {
      email: 'ended@test.com', internshipStartDate: '2020-01-01', internshipEndDate: '2020-06-01',
    });

    // makeIntern logs in, and a login after the end date already deactivates; put them back as "not yet swept"
    await User.updateOne({ _id: user._id }, { active: true });

    const res = await request(app).post('/api/cron/daily').set('X-Cron-Secret', 'correct-secret');
    expect(res.status).toBe(200);
    expect(res.body.ended).toBe(1);
    expect((await User.findById(user._id)).active).toBe(false);
  });
});

describe('POST /api/cron/weekly', () => {
  it('rejects a wrong secret', async () => {
    process.env.CRON_SECRET = 'correct-secret';
    const res = await request(app).post('/api/cron/weekly').set('X-Cron-Secret', 'wrong-secret!');
    expect(res.status).toBe(401);
  });

  it('runs the weekly job when the secret is correct', async () => {
    process.env.CRON_SECRET = 'correct-secret';
    await makeAdmin(app);

    const res = await request(app).post('/api/cron/weekly').set('X-Cron-Secret', 'correct-secret');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1); // one supervisor, one summary
  });
});
