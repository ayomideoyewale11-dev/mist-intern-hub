const { setupTestApp, teardownTestApp, clearDatabase } = require('./testApp');
const { makeAdmin, makeIntern } = require('./helpers');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const mailer = require('../config/mailer');
const welcomeEmailSpy = jest.spyOn(mailer, 'sendWelcomeEmail');

let app;
beforeAll(async () => { app = await setupTestApp(); }, 30000);
afterEach(async () => {
  await clearDatabase();
  welcomeEmailSpy.mockReset();
  welcomeEmailSpy.mockResolvedValue(true);
});
afterAll(teardownTestApp);

describe('POST /api/auth/create-intern', () => {
  it('does not create an intern if loading the supervisor fails', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const findByIdSpy = jest.spyOn(User, 'findById').mockRejectedValueOnce(new Error('database unavailable'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let res;
    try {
      res = await agent.post('/api/auth/create-intern').set('X-CSRF-Token', csrfToken).send({
        name: 'Amaka Obi', email: 'supervisor-read-failure@test.com',
        internshipStartDate: '2026-01-01', internshipEndDate: '2099-06-01',
      });
    } finally {
      findByIdSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(res.status).toBe(500);
    expect(await User.findOne({ email: 'supervisor-read-failure@test.com' })).toBeNull();
    expect(welcomeEmailSpy).not.toHaveBeenCalled();
  });

  it('lets a supervisor create an intern who belongs to them', async () => {
    const { agent, csrfToken, user: admin } = await makeAdmin(app);
    const res = await agent.post('/api/auth/create-intern').set('X-CSRF-Token', csrfToken).send({
      name: 'Amaka Obi', email: 'amaka@test.com',
      internshipStartDate: '2026-01-01', internshipEndDate: '2099-06-01',
    });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe('intern');
    expect(res.body.emailSent).toBe(true);

    const created = await User.findOne({ email: 'amaka@test.com' });
    expect(created).not.toBeNull();
    expect(String(created.supervisor)).toBe(String(admin._id));
    expect(created.active).toBe(true);
    expect(created.resetTokenHash).toBeDefined(); // the "set your password" token

    const entry = await AuditLog.findOne({ action: 'intern-registered', internId: created._id });
    expect(entry).not.toBeNull();
  });

  it('reports when the account is created but the welcome email could not be delivered', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    welcomeEmailSpy.mockResolvedValueOnce(false);

    const res = await agent.post('/api/auth/create-intern').set('X-CSRF-Token', csrfToken).send({
      name: 'Amaka Obi', email: 'mail-failed@test.com',
      internshipStartDate: '2026-01-01', internshipEndDate: '2099-06-01',
    });

    expect(res.status).toBe(201);
    expect(res.body.emailSent).toBe(false);
    expect(await User.findOne({ email: 'mail-failed@test.com' })).not.toBeNull();
  });

  it('ignores any supervisor the request tries to send, using the logged-in supervisor', async () => {
    const { agent, csrfToken, user: admin } = await makeAdmin(app);
    const { user: other } = await makeAdmin(app, { email: 'other@test.com' });
    await agent.post('/api/auth/create-intern').set('X-CSRF-Token', csrfToken).send({
      name: 'Amaka Obi', email: 'amaka@test.com', supervisor: String(other._id), // must be ignored
      internshipStartDate: '2026-01-01', internshipEndDate: '2099-06-01',
    });
    const created = await User.findOne({ email: 'amaka@test.com' });
    expect(String(created.supervisor)).toBe(String(admin._id));
  });

  it('refuses when an intern tries to create another intern account', async () => {
    const { agent, csrfToken } = await makeIntern(app);
    const res = await agent.post('/api/auth/create-intern').set('X-CSRF-Token', csrfToken).send({
      name: 'Amaka Obi', email: 'amaka@test.com',
      internshipStartDate: '2026-01-01', internshipEndDate: '2099-06-01',
    });
    expect(res.status).toBe(403);
  });

  it('rejects an internship end date that is not after the start date', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const res = await agent.post('/api/auth/create-intern').set('X-CSRF-Token', csrfToken).send({
      name: 'Amaka Obi', email: 'amaka@test.com',
      internshipStartDate: '2099-06-01', internshipEndDate: '2099-01-01', // end before start
    });
    expect(res.status).toBe(400);
  });

  it('rejects impossible calendar dates instead of normalizing them', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const res = await agent.post('/api/auth/create-intern').set('X-CSRF-Token', csrfToken).send({
      name: 'Amaka Obi', email: 'invalid-date@test.com',
      internshipStartDate: '2099-02-30', internshipEndDate: '2099-06-01',
    });
    expect(res.status).toBe(400);
    expect(await User.findOne({ email: 'invalid-date@test.com' })).toBeNull();
  });

  it('rejects malformed email addresses before creating an intern', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const res = await agent.post('/api/auth/create-intern').set('X-CSRF-Token', csrfToken).send({
      name: 'Amaka Obi', email: 'not-an-email',
      internshipStartDate: '2026-01-01', internshipEndDate: '2099-06-01',
    });
    expect(res.status).toBe(400);
    expect(await User.findOne({ email: 'not-an-email' })).toBeNull();
  });

  it('rejects an end date that is already in the past', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const res = await agent.post('/api/auth/create-intern').set('X-CSRF-Token', csrfToken).send({
      name: 'Amaka Obi', email: 'amaka@test.com',
      internshipStartDate: '2020-01-01', internshipEndDate: '2020-06-01',
    });
    expect(res.status).toBe(400);
    expect(await User.findOne({ email: 'amaka@test.com' })).toBeNull();
  });

  it('rejects a duplicate email', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const payload = {
      name: 'Amaka Obi', email: 'amaka@test.com',
      internshipStartDate: '2026-01-01', internshipEndDate: '2099-06-01',
    };
    await agent.post('/api/auth/create-intern').set('X-CSRF-Token', csrfToken).send(payload);
    const res = await agent.post('/api/auth/create-intern').set('X-CSRF-Token', csrfToken).send(payload);
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/auth/interns/:id', () => {
  it('rejects malformed replacement email addresses', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const res = await agent.put(`/api/auth/interns/${intern._id}`).set('X-CSRF-Token', csrfToken).send({ email: 'bad@' });
    expect(res.status).toBe(400);
    expect((await User.findById(intern._id)).email).toBe(intern.email);
  });

  it('lets a supervisor edit an intern\'s details', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);

    const res = await agent.put(`/api/auth/interns/${intern._id}`).set('X-CSRF-Token', csrfToken).send({
      name: 'New Name', email: intern.email,
      internshipStartDate: '2026-01-01', internshipEndDate: '2099-12-01',
    });
    expect(res.status).toBe(200);
    expect((await User.findById(intern._id)).name).toBe('New Name');
  });

  it('does not save an edit if loading the supervisor fails', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const findByIdSpy = jest.spyOn(User, 'findById').mockRejectedValueOnce(new Error('database unavailable'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let res;
    try {
      res = await agent.put(`/api/auth/interns/${intern._id}`)
        .set('X-CSRF-Token', csrfToken)
        .send({ name: 'Should not be saved' });
    } finally {
      findByIdSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(res.status).toBe(500);
    expect((await User.findById(intern._id)).name).toBe(intern.name);
  });

  it('emails the intern only when the end date moves later', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const put = (end) => agent.put(`/api/auth/interns/${intern._id}`).set('X-CSRF-Token', csrfToken).send({
      name: intern.name, email: intern.email, internshipStartDate: '2026-01-01', internshipEndDate: end,
    });
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const count = () => spy.mock.calls.filter((c) => String(c[0]).includes('Your internship has been extended')).length;

    await put('2099-01-01'); // same date: no email
    expect(count()).toBe(0);
    await put('2099-06-01'); // later: email
    expect(count()).toBe(1);
    await put('2099-03-01'); // earlier: no email
    expect(count()).toBe(1);
    spy.mockRestore();
  });

  it('logs intern-activated / intern-deactivated specifically when the active flag flips', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);

    await agent.put(`/api/auth/interns/${intern._id}`).set('X-CSRF-Token', csrfToken).send({
      name: intern.name, email: intern.email,
      internshipStartDate: '2026-01-01', internshipEndDate: '2099-12-01', active: false,
    });
    const entry = await AuditLog.findOne({ action: 'intern-deactivated', internId: intern._id });
    expect(entry).not.toBeNull();
  });

  it('rejects an end date that is not after the start date', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);

    const res = await agent.put(`/api/auth/interns/${intern._id}`).set('X-CSRF-Token', csrfToken).send({
      name: intern.name, email: intern.email,
      internshipStartDate: '2099-06-01', internshipEndDate: '2099-01-01',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an impossible calendar date when editing an intern', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const res = await agent.put(`/api/auth/interns/${intern._id}`).set('X-CSRF-Token', csrfToken).send({
      internshipStartDate: '2099-02-30',
    });
    expect(res.status).toBe(400);
    expect((await User.findById(intern._id)).internshipStartDate).toEqual(intern.internshipStartDate);
  });

  it('refuses to reactivate an intern whose end date has passed, until the date is moved forward', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app, {
      email: 'old@test.com', internshipStartDate: '2020-01-01', internshipEndDate: '2020-06-01',
    });
    await User.updateOne({ _id: intern._id }, { active: false });

    const blocked = await agent.put(`/api/auth/interns/${intern._id}`).set('X-CSRF-Token', csrfToken).send({ active: true });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/end date/i);
    expect((await User.findById(intern._id)).active).toBe(false);

    const ok = await agent.put(`/api/auth/interns/${intern._id}`).set('X-CSRF-Token', csrfToken).send({
      internshipEndDate: '2099-12-01', active: true,
    });
    expect(ok.status).toBe(200);
    expect((await User.findById(intern._id)).active).toBe(true);
  });

  it('refuses to edit an intern who belongs to a different supervisor', async () => {
    const { user: owner } = await makeAdmin(app); // owns the intern
    const { user: intern } = await makeIntern(app, { supervisor: owner });
    const { agent, csrfToken } = await makeAdmin(app, { email: 'other@test.com' }); // a different supervisor

    const res = await agent.put(`/api/auth/interns/${intern._id}`).set('X-CSRF-Token', csrfToken).send({
      name: 'Hacked', email: intern.email,
      internshipStartDate: '2026-01-01', internshipEndDate: '2099-12-01',
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/auth/interns/:id/resend-welcome', () => {
  it('does not rotate the setup token if loading the supervisor fails', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    intern.resetTokenHash = 'existing-token-hash';
    intern.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000);
    await intern.save();
    const findByIdSpy = jest.spyOn(User, 'findById').mockRejectedValueOnce(new Error('database unavailable'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let res;
    try {
      res = await agent.post(`/api/auth/interns/${intern._id}/resend-welcome`).set('X-CSRF-Token', csrfToken);
    } finally {
      findByIdSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(res.status).toBe(500);
    const saved = await User.findById(intern._id);
    expect(saved.resetTokenHash).toBe('existing-token-hash');
    expect(saved.resetTokenExpires.getTime()).toBe(intern.resetTokenExpires.getTime());
  });

  it('issues a fresh token and logs the action', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    intern.resetTokenHash = 'existing-welcome-token-hash';
    intern.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000);
    await intern.save();
    const originalHash = intern.resetTokenHash;

    const res = await agent.post(`/api/auth/interns/${intern._id}/resend-welcome`).set('X-CSRF-Token', csrfToken);
    expect(res.status).toBe(200);

    const updated = await User.findById(intern._id);
    expect(updated.resetTokenHash).toBeDefined();
    expect(updated.resetTokenHash).not.toBe(originalHash);

    const entry = await AuditLog.findOne({ action: 'welcome-resent', internId: intern._id });
    expect(entry).not.toBeNull();
  });

  it('keeps the existing setup link when the replacement email fails', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    intern.resetTokenHash = 'existing-welcome-token-hash';
    intern.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000);
    await intern.save();
    const originalHash = intern.resetTokenHash;
    const originalExpiry = intern.resetTokenExpires;
    welcomeEmailSpy.mockResolvedValueOnce(false);

    const res = await agent.post(`/api/auth/interns/${intern._id}/resend-welcome`).set('X-CSRF-Token', csrfToken);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/previous setup link remains valid/i);
    const saved = await User.findById(intern._id);
    expect(saved.resetTokenHash).toBe(originalHash);
    expect(saved.resetTokenExpires.getTime()).toBe(originalExpiry.getTime());
    expect(await AuditLog.findOne({ action: 'welcome-resent', internId: intern._id })).toBeNull();
  });

  it('does not claim an old setup link is valid when none exists', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    intern.resetTokenHash = undefined;
    intern.resetTokenExpires = undefined;
    await intern.save();
    welcomeEmailSpy.mockResolvedValueOnce(false);

    const res = await agent.post(`/api/auth/interns/${intern._id}/resend-welcome`).set('X-CSRF-Token', csrfToken);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/no valid setup link/i);
    const saved = await User.findById(intern._id);
    expect(saved.resetTokenHash).toBeUndefined();
    expect(saved.resetTokenExpires).toBeUndefined();
  });
});
