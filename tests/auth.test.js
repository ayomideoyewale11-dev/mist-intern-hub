const request = require('supertest');
const { setupTestApp, teardownTestApp, clearDatabase } = require('./testApp');
const { getCsrfToken, makeIntern } = require('./helpers');
const User = require('../models/User');
const crypto = require('crypto');
const scheduler = require('../config/scheduler');
const mailer = require('../config/mailer');
const endedSweepSpy = jest.spyOn(scheduler, 'deactivateEndedInternships');
const resetEmailSpy = jest.spyOn(mailer, 'sendPasswordResetEmail');
const { logout } = require('../controllers/authController');

let app;
beforeAll(async () => { app = await setupTestApp(); }, 30000);
afterEach(clearDatabase);
afterAll(async () => {
  endedSweepSpy.mockRestore();
  resetEmailSpy.mockRestore();
  await teardownTestApp();
});

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials and starts a session', async () => {
    const { agent } = await makeIntern(app);
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('intern');
  });

  it('rejects the wrong password', async () => {
    const { agent, csrfToken } = await makeIntern(app, { email: 'wrong-pw@test.com' });
    const res = await agent.post('/api/auth/login').set('X-CSRF-Token', csrfToken).send({
      email: 'wrong-pw@test.com', password: 'TotallyWrongPassword',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/supervisor must register you/);
  });

  it('rejects passwords whose UTF-8 encoding exceeds bcrypt’s 72-byte limit', async () => {
    const { agent, csrfToken } = await makeIntern(app, { email: 'long-pw@test.com' });
    const res = await agent.post('/api/auth/login').set('X-CSRF-Token', csrfToken).send({
      email: 'long-pw@test.com', password: `Password123${'x'.repeat(62)}`,
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/72 UTF-8 bytes.*Forgot password/i);
  });

  it('uses the refreshed end date when an extension races the login sweep', async () => {
    const { user } = await makeIntern(app, { email: 'extended-during-login@test.com' });
    await User.updateOne({ _id: user._id }, {
      $set: { active: true, internshipEndDate: new Date('2020-06-01T00:00:00.000Z') },
    });
    endedSweepSpy.mockImplementationOnce(async () => {
      await User.updateOne({ _id: user._id }, {
        $set: { active: true, internshipEndDate: new Date('2099-06-01T00:00:00.000Z') },
      });
      return 0;
    });

    const agent = request.agent(app);
    const csrfToken = await getCsrfToken(agent);
    const res = await agent.post('/api/auth/login').set('X-CSRF-Token', csrfToken).send({
      email: user.email, password: 'Password123',
    });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('intern');
    expect((await User.findById(user._id)).active).toBe(true);
  });

  it('gives the same message whether the account exists or not', async () => {
    const { agent, csrfToken } = await makeIntern(app, { email: 'exists@test.com' });
    const post = (email) => agent.post('/api/auth/login').set('X-CSRF-Token', csrfToken).send({ email, password: 'TotallyWrongPassword' });
    const known = await post('exists@test.com');
    const unknown = await post('nobody@test.com');
    expect(known.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe(known.body.error);
  });

  it('rejects a request with a missing or wrong CSRF token', async () => {
    const agent = request.agent(app);
    await getCsrfToken(agent); // cookie is set, but we deliberately don't send the header
    const res = await agent.post('/api/auth/login').send({ email: 'a@test.com', password: 'Password123' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/auth/forgot-password', () => {
  it('returns the same generic message whether or not the email exists', async () => {
    const agent = request.agent(app);
    const csrfToken = await getCsrfToken(agent);
    const real = await agent.post('/api/auth/forgot-password').set('X-CSRF-Token', csrfToken).send({ email: 'nobody@test.com' });
    expect(real.status).toBe(200);
    expect(real.body.message).toMatch(/if that email has an account/i);
  });

  it('keeps the previous reset link valid when sending a replacement fails', async () => {
    const { user } = await makeIntern(app, { email: 'reset-delivery@test.com' });
    const previousExpiry = new Date(Date.now() + 30 * 60 * 1000);
    user.resetTokenHash = 'previous-token-hash';
    user.resetTokenExpires = previousExpiry;
    await user.save();
    resetEmailSpy.mockResolvedValueOnce(false);

    const agent = request.agent(app);
    const csrfToken = await getCsrfToken(agent);
    const res = await agent.post('/api/auth/forgot-password')
      .set('X-CSRF-Token', csrfToken)
      .send({ email: user.email });

    const saved = await User.findById(user._id);
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if that email has an account/i);
    expect(saved.resetTokenHash).toBe('previous-token-hash');
    expect(saved.resetTokenExpires.getTime()).toBe(previousExpiry.getTime());
  });
});

describe('long legacy password recovery', () => {
  it('lets a user who cannot use an overlong legacy password reset to a supported one', async () => {
    const { user } = await makeIntern(app, { email: 'legacy-long-pw@test.com' });
    const token = 'legacy-long-password-reset-token';
    user.resetTokenHash = crypto.createHash('sha256').update(token).digest('hex');
    user.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000);
    await user.save();

    const agent = request.agent(app);
    const csrfToken = await getCsrfToken(agent);
    const reset = await agent.post(`/api/auth/reset-password/${token}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ password: 'NewSupportedPassword123' });
    expect(reset.status).toBe(200);

    const login = await agent.post('/api/auth/login').set('X-CSRF-Token', csrfToken)
      .send({ email: user.email, password: 'NewSupportedPassword123' });
    expect(login.status).toBe(200);
  });
});

describe('GET / (home page)', () => {
  it('shows the welcome page to a logged-out visitor', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/MIST Intern Hub/);
  });

  it('redirects a logged-in intern straight to their dashboard', async () => {
    const { agent } = await makeIntern(app);
    const res = await agent.get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/intern');
  });
});

describe('GET /register (removed)', () => {
  it('redirects to /login instead of showing a sign-up form', async () => {
    const res = await request(app).get('/register');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});

describe('POST /api/auth/register (removed)', () => {
  it('no longer exists', async () => {
    const agent = request.agent(app);
    const csrfToken = await getCsrfToken(agent);
    const res = await agent.post('/api/auth/register').set('X-CSRF-Token', csrfToken).send({ name: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('account security fixes', () => {
  const supertest = require('supertest');
  const User = require('../models/User');

  it('logs in even when the email has stray spaces around it', async () => {
    const agent = supertest.agent(app);
    const csrf = await getCsrfToken(agent);
    await makeIntern(app, { email: 'space@test.com' });
    const res = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ email: '  Space@Test.com ', password: 'Password123' });
    expect(res.status).toBe(200);
  });

  it('sends no reset email to an intern whose internship has ended, but replies the same', async () => {
    const { user } = await makeIntern(app, { email: 'gone@test.com' });
    await User.updateOne({ _id: user._id }, { active: false });
    const agent = supertest.agent(app);
    const csrf = await getCsrfToken(agent);
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const res = await agent.post('/api/auth/forgot-password').set('X-CSRF-Token', csrf).send({ email: 'gone@test.com' });
    const mailed = spy.mock.calls.some((c) => String(c[0]).includes('gone@test.com'));
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(mailed).toBe(false);
    expect((await User.findById(user._id)).resetTokenHash).toBeUndefined();
  });

  it('changing a password ends the logins on other devices but keeps this one', async () => {
    const { agent: phone, csrfToken } = await makeIntern(app, { email: 'multi@test.com' });
    const laptop = supertest.agent(app);
    const csrf2 = await getCsrfToken(laptop);
    await laptop.post('/api/auth/login').set('X-CSRF-Token', csrf2).send({ email: 'multi@test.com', password: 'Password123' });
    expect((await laptop.get('/api/auth/me')).status).toBe(200);

    const res = await phone.post('/api/auth/change-password').set('X-CSRF-Token', csrfToken)
      .send({ currentPassword: 'Password123', newPassword: 'NewPassword456' });
    expect(res.status).toBe(200);
    expect((await phone.get('/api/auth/me')).status).toBe(200); // this device stays logged in
    expect((await laptop.get('/api/auth/me')).status).toBe(401); // the other one is logged out
  });

  it('reports a session-store failure instead of claiming other sessions were ended', async () => {
    const { agent, csrfToken } = await makeIntern(app, { email: 'session-error@test.com' });
    const db = require('mongoose').connection.db;
    const collection = db.collection;
    const collectionSpy = jest.spyOn(db, 'collection').mockImplementation(function (name, ...args) {
      if (name === 'sessions') return { deleteMany: jest.fn().mockRejectedValue(new Error('store unavailable')) };
      return collection.call(this, name, ...args);
    });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await agent.post('/api/auth/change-password').set('X-CSRF-Token', csrfToken)
        .send({ currentPassword: 'Password123', newPassword: 'NewPassword456' });
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/could not change password/i);
    } finally {
      collectionSpy.mockRestore();
      error.mockRestore();
    }
  });

  it('rejects a new password over 72 UTF-8 bytes without changing the current password', async () => {
    const { agent, csrfToken, user } = await makeIntern(app, { email: 'long-change@test.com' });
    const res = await agent.post('/api/auth/change-password').set('X-CSRF-Token', csrfToken)
      .send({ currentPassword: 'Password123', newPassword: `NewPassword${'x'.repeat(62)}` });
    expect(res.status).toBe(400);
    const saved = await User.findById(user._id);
    expect(await require('bcrypt').compare('Password123', saved.passwordHash)).toBe(true);
  });
});

describe('malformed requests', () => {
  it('answers 400, not 500, when the body is not valid JSON', async () => {
    const agent = request.agent(app);
    const csrfToken = await getCsrfToken(agent);
    const res = await agent.post('/api/auth/login').set('X-CSRF-Token', csrfToken)
      .set('Content-Type', 'application/json').send('{ this is not json');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('answers 413 for a body over the size limit', async () => {
    const agent = request.agent(app);
    const csrfToken = await getCsrfToken(agent);
    const res = await agent.post('/api/auth/login').set('X-CSRF-Token', csrfToken)
      .send({ email: 'a@b.com', password: 'x'.repeat(70 * 1024) });
    expect(res.status).toBe(413);
  });
});

describe('logout session-store errors', () => {
  it('does not return success or clear the cookie when session destruction fails', () => {
    const failure = new Error('session store unavailable');
    const req = { session: { destroy: (callback) => callback(failure) } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), clearCookie: jest.fn() };
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      logout(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ error: 'Could not log out.' });
      expect(res.clearCookie).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
