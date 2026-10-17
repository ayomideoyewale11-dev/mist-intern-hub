const request = require('supertest');
const { setupTestApp, teardownTestApp, clearDatabase } = require('./testApp');
const { makeAdmin, makeIntern, getCsrfToken } = require('./helpers');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const Task = require('../models/Task');

let app;
beforeAll(async () => { app = await setupTestApp(); }, 30000);
afterEach(clearDatabase);
afterAll(teardownTestApp);

const terminate = (agent, csrfToken, id, body) =>
  agent.post(`/api/auth/interns/${id}/terminate`).set('X-CSRF-Token', csrfToken).send(body);

describe('POST /api/auth/interns/:id/terminate', () => {
  it('does not terminate an intern if loading the supervisor fails', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const findByIdSpy = jest.spyOn(User, 'findById').mockRejectedValueOnce(new Error('database unavailable'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let res;
    try {
      res = await terminate(agent, csrfToken, intern._id, { reason: 'Role ended' });
    } finally {
      findByIdSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(res.status).toBe(500);
    const saved = await User.findById(intern._id);
    expect(saved.active).toBe(true);
    expect(saved.terminatedAt).toBeUndefined();
    expect(saved.terminationReason).toBeUndefined();
  });

  it('completes termination if audit logging fails', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const createSpy = jest.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let res;
    let loggedAuditFailure = false;
    try {
      res = await terminate(agent, csrfToken, intern._id, { reason: 'Role ended' });
      loggedAuditFailure = errorSpy.mock.calls.some((call) =>
        call[0] === '[audit] Failed to log action:' && call[1] === 'audit unavailable');
    } finally {
      createSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(res.status).toBe(200);
    expect((await User.findById(intern._id)).active).toBe(false);
    expect(loggedAuditFailure).toBe(true);
  });

  it('ends the internship, records the reason, and logs the intern out on their next request', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { agent: internAgent, user: intern } = await makeIntern(app);
    expect((await internAgent.get('/api/tasks')).status).toBe(200); // logged in and allowed

    const res = await terminate(agent, csrfToken, intern._id, { reason: '  Repeated absence without notice  ' });
    expect(res.status).toBe(200);

    const saved = await User.findById(intern._id);
    expect(saved.active).toBe(false);
    expect(saved.terminatedAt).toBeInstanceOf(Date);
    expect(saved.terminationReason).toBe('Repeated absence without notice'); // trimmed

    const entry = await AuditLog.findOne({ action: 'intern-terminated', internId: intern._id });
    expect(entry).not.toBeNull();
    expect(entry.details).toMatch(/Repeated absence without notice/);
    expect(String(entry.supervisor)).toBe(String(intern.supervisor));
    expect(String(entry.performedBy)).toBe(String(intern.supervisor));
    expect(entry.performedByName).toBe('Mrs Admin');

    expect((await internAgent.get('/api/tasks')).status).toBe(401); // the existing login stops working
  });

  it('emails the intern that the internship has been terminated', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await terminate(agent, csrfToken, intern._id, { reason: 'Repeated absence without notice' });
      const lines = log.mock.calls.map((c) => c.join(' '));
      expect(lines.some((l) => l.includes('"Your internship has been terminated" to intern@test.com'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('tells a terminated intern who tries to log in that their supervisor ended the internship', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    await terminate(agent, csrfToken, intern._id, { reason: 'Misconduct' });

    const fresh = request.agent(app);
    const token = await getCsrfToken(fresh);
    const res = await fresh.post('/api/auth/login').set('X-CSRF-Token', token).send({ email: 'intern@test.com', password: 'Password123' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/terminated by your supervisor/);
  });

  it('does not reveal the termination to someone who gets the password wrong', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    await terminate(agent, csrfToken, intern._id, { reason: 'Misconduct' });

    const fresh = request.agent(app);
    const token = await getCsrfToken(fresh);
    const res = await fresh.post('/api/auth/login').set('X-CSRF-Token', token).send({ email: 'intern@test.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('requires a reason, and refuses a very long one', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    expect((await terminate(agent, csrfToken, intern._id, {})).status).toBe(400);
    expect((await terminate(agent, csrfToken, intern._id, { reason: '   ' })).status).toBe(400);
    expect((await terminate(agent, csrfToken, intern._id, { reason: 'x'.repeat(501) })).status).toBe(400);
    expect((await User.findById(intern._id)).active).toBe(true); // nothing happened
  });

  it('refuses when the internship has already ended', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    await User.updateOne({ _id: intern._id }, { active: false });
    const res = await terminate(agent, csrfToken, intern._id, { reason: 'Misconduct' });
    expect(res.status).toBe(400);
    expect((await User.findById(intern._id)).terminatedAt).toBeUndefined();
  });

  it("will not terminate another supervisor's intern, and interns cannot call it", async () => {
    const { user: other } = await makeAdmin(app, { email: 'other@test.com' });
    const { user: theirs } = await makeIntern(app, { supervisor: other, email: 'theirs@test.com' });
    const { agent, csrfToken } = await makeAdmin(app); // the default supervisor
    expect((await terminate(agent, csrfToken, theirs._id, { reason: 'Misconduct' })).status).toBe(404);
    expect((await terminate(agent, csrfToken, 'not-an-id', { reason: 'Misconduct' })).status).toBe(404);

    const { agent: internAgent, csrfToken: internToken, user: mine } = await makeIntern(app, { email: 'mine@test.com' });
    expect((await terminate(internAgent, internToken, mine._id, { reason: 'Misconduct' })).status).toBe(403);
    expect((await User.findById(theirs._id)).active).toBe(true);
  });

  it('can be undone: restoring the intern clears the termination and logs it', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    await terminate(agent, csrfToken, intern._id, { reason: 'Misconduct' });

    const res = await agent.put(`/api/auth/interns/${intern._id}`).set('X-CSRF-Token', csrfToken).send({ active: true });
    expect(res.status).toBe(200);
    const saved = await User.findById(intern._id);
    expect(saved.active).toBe(true);
    expect(saved.terminatedAt).toBeUndefined();
    expect(saved.terminationReason).toBeUndefined();
    const restored = await AuditLog.findOne({ action: 'intern-activated', internId: intern._id });
    expect(restored.details).toMatch(/Termination reversed/);
  });

  it('emails the intern when a terminated internship is reactivated', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    await terminate(agent, csrfToken, intern._id, { reason: 'Misconduct' });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await agent.put(`/api/auth/interns/${intern._id}`).set('X-CSRF-Token', csrfToken).send({ active: true });
      const lines = log.mock.calls.map((c) => c.join(' '));
      expect(lines.some((l) => l.includes('"Your account has been reactivated" to intern@test.com'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('sends only the reactivation email (not also "extended") when the end date moves too', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    await terminate(agent, csrfToken, intern._id, { reason: 'Misconduct' });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await agent.put(`/api/auth/interns/${intern._id}`).set('X-CSRF-Token', csrfToken)
        .send({ active: true, internshipEndDate: '2099-06-01' });
      const lines = log.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(lines).toMatch(/Your account has been reactivated/);
      expect(lines).not.toMatch(/Your internship has been extended/);
    } finally {
      log.mockRestore();
    }
  });

  it('sends no reactivation email when only details are edited on a terminated intern', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    await terminate(agent, csrfToken, intern._id, { reason: 'Misconduct' });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await agent.put(`/api/auth/interns/${intern._id}`).set('X-CSRF-Token', csrfToken).send({ name: 'Renamed', active: false });
      const lines = log.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(lines).not.toMatch(/reactivated/);
    } finally {
      log.mockRestore();
    }
  });

  it('does not clear the termination just because other details were edited', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    await terminate(agent, csrfToken, intern._id, { reason: 'Misconduct' });
    await agent.put(`/api/auth/interns/${intern._id}`).set('X-CSRF-Token', csrfToken).send({ name: 'Renamed Intern', active: false });
    const saved = await User.findById(intern._id);
    expect(saved.active).toBe(false);
    expect(saved.terminationReason).toBe('Misconduct');
  });
});

describe('termination on the pages', () => {
  it('shows the Terminate section only for an active intern', async () => {
    const { agent } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const res = await agent.get(`/interns/${intern._id}/edit`);
    expect(res.text).toMatch(/id="terminate-form"/);
    expect(res.text).toMatch(/Terminate internship/);
  });

  it('marks a terminated intern in Alumni, on their history, and on the edit page', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    await terminate(agent, csrfToken, intern._id, { reason: 'Repeated absence' });

    const alumni = await agent.get('/alumni');
    expect(alumni.text).toMatch(/Terminated/);

    const history = await agent.get(`/interns/${intern._id}`);
    expect(history.text).toMatch(/Terminated/);
    expect(history.text).toMatch(/Reason: Repeated absence/);

    const edit = await agent.get(`/interns/${intern._id}/edit`);
    expect(edit.text).toMatch(/Internship terminated/);
    expect(edit.text).toMatch(/Reason: Repeated absence/);
    expect(edit.text).not.toMatch(/id="terminate-form"/);
  });

  it('does not mark an intern whose internship simply ended', async () => {
    const { agent } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    await User.updateOne({ _id: intern._id }, { active: false });
    const alumni = await agent.get('/alumni');
    expect(alumni.text).toMatch(/Intern One/);
    expect(alumni.text).not.toMatch(/Terminated/);
    const edit = await agent.get(`/interns/${intern._id}/edit`);
    expect(edit.text).not.toMatch(/id="terminate-form"/); // already ended: nothing to terminate
  });
});

describe('a terminated intern\'s tasks are hidden from the supervisor', () => {
  const mkTask = (admin, intern, title, extra = {}) =>
    Task.create({ title, description: 'd', assignedTo: intern._id, createdBy: admin._id, dueDate: '2099-01-01', ...extra });

  it('hides them from the Archive, the API lists and the Archive search, and brings them back on restore', async () => {
    const { agent, csrfToken, user: admin } = await makeAdmin(app);
    const { user: gone } = await makeIntern(app, { name: 'Gone Intern', email: 'gone@test.com' });
    const { user: stays } = await makeIntern(app, { name: 'Staying Intern', email: 'stays@test.com' });
    await mkTask(admin, gone, 'Gone open task');
    await mkTask(admin, stays, 'Staying open task');

    let archive = await agent.get('/archive');
    expect(archive.text).toMatch(/Gone Intern/);

    await terminate(agent, csrfToken, gone._id, { reason: 'Misconduct' });

    archive = await agent.get('/archive');
    expect(archive.text).not.toMatch(/Gone Intern/);
    expect(archive.text).not.toMatch(/Gone open task/);
    expect(archive.text).toMatch(/Staying Intern/);

    const archived = await agent.get('/api/tasks/archived');
    expect(archived.body.map((t) => t.title)).toEqual(['Staying open task']);
    const live = await agent.get('/api/tasks');
    expect(live.body.map((t) => t.title)).toEqual(['Staying open task']);

    const found = await agent.get('/api/suggest?kind=archive&q=Gone');
    expect(found.body.items).toEqual([]);

    // restoring brings everything back
    await agent.put(`/api/auth/interns/${gone._id}`).set('X-CSRF-Token', csrfToken).send({ active: true });
    const back = await agent.get('/api/tasks/archived');
    expect(back.body.map((t) => t.title).sort()).toEqual(['Gone open task', 'Staying open task']);
    expect((await agent.get('/archive')).text).toMatch(/Gone Intern/);
  });

  it('leaves them out of the Dashboard counts and the waiting-for-feedback card', async () => {
    const { agent, csrfToken, user: admin } = await makeAdmin(app);
    const { user: gone } = await makeIntern(app, { name: 'Gone Intern', email: 'gone@test.com' });
    await mkTask(admin, gone, 'Gone submitted task', { submission: { submittedAt: new Date(), note: 'done' } });

    let dash = await agent.get('/admin');
    expect(dash.text).toMatch(/Gone submitted task/); // waiting for feedback while the intern is active

    await terminate(agent, csrfToken, gone._id, { reason: 'Misconduct' });
    dash = await agent.get('/admin');
    expect(dash.text).not.toMatch(/Gone submitted task/);
    expect(dash.text).not.toMatch(/Gone Intern/);
  });

  it('does not extend or email a terminated intern\'s copy when the batch due date is moved', async () => {
    const { agent, csrfToken, user: admin } = await makeAdmin(app);
    const { user: gone } = await makeIntern(app, { name: 'Gone Intern', email: 'gone@test.com' });
    const { user: stays } = await makeIntern(app, { name: 'Staying Intern', email: 'stays@test.com' });
    const batchId = new (require('mongoose').Types.ObjectId)();
    const a = await mkTask(admin, gone, 'Batch task', { batchId });
    const b = await mkTask(admin, stays, 'Batch task', { batchId });
    await terminate(agent, csrfToken, gone._id, { reason: 'Misconduct' });

    const res = await agent.put(`/api/tasks/batch/${batchId}`).set('X-CSRF-Token', csrfToken).send({ dueDate: '2099-06-01' });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1); // only the intern who is still here
    const month = async (task) => (await Task.findById(task._id)).dueDate.toISOString().slice(0, 7);
    expect(await month(a)).toBe('2099-01'); // the terminated intern's copy: unchanged
    expect(await month(b)).toBe('2099-06'); // the other intern's copy: moved
  });

  it('still lists the intern on Alumni, marked Terminated, with their history reachable', async () => {
    const { agent, csrfToken, user: admin } = await makeAdmin(app);
    const { user: gone } = await makeIntern(app, { name: 'Gone Intern', email: 'gone@test.com' });
    await mkTask(admin, gone, 'Gone open task');
    await terminate(agent, csrfToken, gone._id, { reason: 'Misconduct' });
    expect((await agent.get('/alumni')).text).toMatch(/Gone Intern/);
    expect((await agent.get(`/interns/${gone._id}`)).text).toMatch(/Gone open task/);
  });
});

describe('no welcome email or batch changes for an intern who is no longer here', () => {
  it('hides the Welcome email section for an inactive intern, and the server refuses the resend', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    expect((await agent.get(`/interns/${intern._id}/edit`)).text).toMatch(/Resend welcome email/); // active: shown

    await terminate(agent, csrfToken, intern._id, { reason: 'Misconduct' });
    expect((await agent.get(`/interns/${intern._id}/edit`)).text).not.toMatch(/Resend welcome email/);
    const res = await agent.post(`/api/auth/interns/${intern._id}/resend-welcome`).set('X-CSRF-Token', csrfToken);
    expect(res.status).toBe(400);
  });

  it('also hides it for an intern whose internship simply ended', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    await User.updateOne({ _id: intern._id }, { active: false });
    expect((await agent.get(`/interns/${intern._id}/edit`)).text).not.toMatch(/Resend welcome email/);
    expect((await agent.post(`/api/auth/interns/${intern._id}/resend-welcome`).set('X-CSRF-Token', csrfToken)).status).toBe(400);
  });

  it('does not change or email the batch copy of an intern whose internship ended normally', async () => {
    const { agent, csrfToken, user: admin } = await makeAdmin(app);
    const { user: gone } = await makeIntern(app, { name: 'Ended Intern', email: 'ended@test.com' });
    const { user: stays } = await makeIntern(app, { name: 'Staying Intern', email: 'stays@test.com' });
    const batchId = new (require('mongoose').Types.ObjectId)();
    const mk = (who) => Task.create({ title: 'Batch task', description: 'd', assignedTo: who._id, createdBy: admin._id, dueDate: '2099-01-01', batchId });
    const a = await mk(gone);
    const b = await mk(stays);
    await User.updateOne({ _id: gone._id }, { active: false }); // ended, not terminated

    const res = await agent.put(`/api/tasks/batch/${batchId}`).set('X-CSRF-Token', csrfToken).send({ dueDate: '2099-06-01' });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    const month = async (task) => (await Task.findById(task._id)).dueDate.toISOString().slice(0, 7);
    expect(await month(a)).toBe('2099-01');
    expect(await month(b)).toBe('2099-06');
  });
});

describe('editing an intern who is still inactive, and bad dates', () => {
  it('does not send an "extended" email when the end date moves later but the intern stays inactive', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    await terminate(agent, csrfToken, intern._id, { reason: 'Misconduct' });
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const res = await agent.put(`/api/auth/interns/${intern._id}`).set('X-CSRF-Token', csrfToken).send({ internshipEndDate: '2099-12-31' });
    const extended = spy.mock.calls.filter((c) => String(c[0]).includes('Your internship has been extended')).length;
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(extended).toBe(0);
    expect((await User.findById(intern._id)).active).toBe(false);
  });

  it('answers 400, not 500, to a malformed date', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    for (const body of [{ internshipEndDate: 'not-a-date' }, { internshipStartDate: 'nope' }]) {
      const res = await agent.put(`/api/auth/interns/${intern._id}`).set('X-CSRF-Token', csrfToken).send(body);
      expect(res.status).toBe(400);
    }
  });
});
