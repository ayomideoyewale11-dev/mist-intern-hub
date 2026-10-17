const request = require('supertest');
const { setupTestApp, teardownTestApp, clearDatabase } = require('./testApp');
const { makeAdmin, makeIntern } = require('./helpers');
const Task = require('../models/Task');
const User = require('../models/User');
const { pdfText } = require('../config/exports');
const { localDateKey } = require('../config/dateBoundaries');

let app;
beforeAll(async () => { app = await setupTestApp(); }, 30000);
afterEach(clearDatabase);
afterAll(teardownTestApp);

describe('Logged-out visitors', () => {
  it('renders the application time-zone date for browser date controls', async () => {
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`<meta name="app-date" content="${localDateKey().toISOString().slice(0, 10)}">`);
  });

  it.each([
    '/admin', '/intern', '/archive', '/my-history', '/account',
    '/alumni', '/audit-log', '/interns', '/interns/new',
  ])('redirects %s to /login', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});

describe('Role gating', () => {
  it('sends an intern who requests an admin-only page back to /intern', async () => {
    const { agent } = await makeIntern(app);
    const res = await agent.get('/archive');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/intern');
  });

  it('sends an admin who requests /intern back to /admin', async () => {
    const { agent } = await makeAdmin(app);
    const res = await agent.get('/intern');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin');
  });

  it('sends an admin who requests /my-history (intern-only) back to /admin', async () => {
    const { agent } = await makeAdmin(app);
    const res = await agent.get('/my-history');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin');
  });
});

describe('Admin pages render with real content', () => {
  it('GET /admin shows the assign-task form', async () => {
    const { agent } = await makeAdmin(app);
    const res = await agent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Assign a task/);
  });

  it('GET /admin lists submitted tasks that are still waiting for feedback', async () => {
    const { agent, user: admin } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const sub = { submittedAt: new Date(), link: 'https://x.com' };
    const mk = (title, submission) => Task.create({ title, description: 'd', assignedTo: intern._id, createdBy: admin._id, dueDate: '2099-01-01', ...(submission ? { submission } : {}) });
    await mk('Needs a look', sub);
    await mk('Already reviewed', { ...sub, feedback: { text: 'Well done', givenAt: new Date() } });
    await mk('Not handed in yet');
    const res = await agent.get('/admin');
    expect(res.text).toMatch(/1 submission is waiting for your feedback/);
    expect(res.text).toMatch(/>Needs a look<\/a>/);
    expect(res.text).not.toMatch(/>Already reviewed<\/a>/);
    expect(res.text).not.toMatch(/>Not handed in yet<\/a>/);
  });

  it('GET /admin hides the feedback card when nothing is waiting', async () => {
    const { agent } = await makeAdmin(app);
    const res = await agent.get('/admin');
    expect(res.text).not.toMatch(/waiting for your feedback/);
  });

  it('GET /admin lists each intern with done, open and overdue counts, overdue first', async () => {
    const { agent, user: admin } = await makeAdmin(app);
    const { user: a } = await makeIntern(app, { name: 'Alpha Intern', email: 'alpha@test.com' });
    const { user: b } = await makeIntern(app, { name: 'Bravo Intern', email: 'bravo@test.com' });
    const mk = (who, extra) => Task.create({ title: 't', description: 'd', assignedTo: who._id, createdBy: admin._id, ...extra });
    await mk(a, { dueDate: '2099-01-01' });
    await mk(a, { dueDate: '2000-01-01', submission: { submittedAt: new Date(), link: 'https://x.com' } });
    await mk(b, { dueDate: '2000-01-01' });
    await mk(b, { dueDate: '2000-02-01' });
    const res = await agent.get('/admin');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Intern progress/);
    // Bravo has two overdue tasks, so it is listed before Alpha
    // match the progress links: the "Assign to" picker lists the interns alphabetically too
    const at = (name) => res.text.indexOf(`>${name}</a>`);
    expect(at('Bravo Intern')).toBeGreaterThan(-1);
    expect(at('Bravo Intern')).toBeLessThan(at('Alpha Intern'));
  });

  it('pages the intern progress card 8 interns at a time', async () => {
    const { agent } = await makeAdmin(app);
    for (let i = 1; i <= 9; i++) {
      await makeIntern(app, { name: `Intern ${String(i).padStart(2, '0')}`, email: `p${i}@test.com` });
    }
    const first = await agent.get('/admin');
    expect(first.status).toBe(200);
    expect(first.text).toMatch(/Page 1 of 2 \(9 interns\)/);
    // look for the intern's name as a link: the "Assign to" picker lists every intern too
    expect(first.text).toMatch(/>Intern 01<\/a>/);
    expect(first.text).not.toMatch(/>Intern 09<\/a>/);
    const second = await agent.get('/admin?page=2');
    expect(second.text).toMatch(/Page 2 of 2/);
    expect(second.text).toMatch(/>Intern 09<\/a>/);
  });

  it('GET /admin shows the counts of open, overdue and submitted tasks and active interns', async () => {
    const { agent, user: admin } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const mk = (extra) => Task.create({ title: 't', description: 'd', assignedTo: intern._id, createdBy: admin._id, ...extra });
    await mk({ dueDate: '2099-01-01' });
    await mk({ dueDate: '2099-02-01' });
    await mk({ dueDate: '2000-01-01' });
    await mk({ dueDate: '2099-01-01', submission: { link: 'https://example.com', submittedAt: new Date() } });
    // another supervisor's tasks must never be counted
    const other = await User.create({ name: 'Other', email: 'other@test.com', passwordHash: 'x', role: 'admin' });
    await Task.create({ title: 'theirs', description: 'd', dueDate: '2099-01-01', assignedTo: intern._id, createdBy: other._id });

    const res = await agent.get('/admin');
    const num = (href) => Number(res.text.match(new RegExp(`${href}"[^>]*><strong>(\\d+)</strong>`))[1]);
    expect(num('/archive\\?status=open')).toBe(2);
    expect(num('/archive\\?status=overdue')).toBe(1);
    expect(num('/archive\\?status=submitted')).toBe(1);
    expect(num('/interns')).toBe(1);
  });

  it('GET /interns/new shows the registration form', async () => {
    const { agent } = await makeAdmin(app);
    const res = await agent.get('/interns/new');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Register a new intern/);
  });

  it('GET /archive shows a task that was assigned', async () => {
    const { agent, user: admin } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    await Task.create({
      title: 'Visible in archive', description: 'd', dueDate: '2099-01-01',
      assignedTo: intern._id, createdBy: admin._id,
    });

    const res = await agent.get('/archive');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Visible in archive/);
    expect(res.text).toMatch(/<strong>1<\/strong> open/); // summary chips count the one task
  });

  it('GET /archive shows whether a submitted task has feedback', async () => {
    const { agent, user: admin } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app, { supervisor: admin });
    const base = { description: 'd', dueDate: '2099-01-01', assignedTo: intern._id, createdBy: admin._id };
    await Task.create({ ...base, title: 'Has fb', submission: { link: 'https://x.com', submittedAt: new Date(), feedback: { text: 'Good', givenAt: new Date() } } });
    await Task.create({ ...base, title: 'No fb', submission: { link: 'https://x.com', submittedAt: new Date() } });
    const res = await agent.get('/archive');
    expect(res.text).toMatch(/Feedback given/);
    expect(res.text).toMatch(/Needs feedback/);
  });

  it('GET /archive?page=2 sends you to the last real page when there is no second page', async () => {
    const { agent } = await makeAdmin(app);
    const res = await agent.get('/archive?page=2');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/archive');
  });

  it('GET /archive?q= and ?status= filter on the server, across every page', async () => {
    const { agent, user: admin } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app, { supervisor: admin });
    const base = { description: 'd', assignedTo: intern._id, createdBy: admin._id };
    await Task.create({ ...base, title: 'Alpha report', dueDate: '2099-01-01' });
    await Task.create({ ...base, title: 'Beta report', dueDate: '2020-01-01' });
    await Task.create({ ...base, title: 'Gamma done', dueDate: '2099-01-01', submission: { link: 'https://x.com', submittedAt: new Date() } });

    let res = await agent.get('/archive?q=alpha');
    expect(res.text).toMatch(/Alpha report/);
    expect(res.text).not.toMatch(/Beta report/);

    res = await agent.get('/archive?status=overdue');
    expect(res.text).toMatch(/Beta report/);
    expect(res.text).not.toMatch(/Alpha report/);
    expect(res.text).not.toMatch(/Gamma done/);

    res = await agent.get('/archive?status=submitted');
    expect(res.text).toMatch(/Gamma done/);
    expect(res.text).not.toMatch(/Alpha report/);

    res = await agent.get(`/archive?q=${encodeURIComponent(intern.name)}`); // by intern name
    expect(res.text).toMatch(/Alpha report/);
    expect(res.text).toMatch(/<strong>1<\/strong> open/); // chips stay the full totals

    res = await agent.get('/archive?q=%5B(');  // regex characters are treated as plain text
    expect(res.status).toBe(200);
  });

  it('GET /interns with no interns at all shows the "Register Intern" call to action', async () => {
    const { agent } = await makeAdmin(app);
    const res = await agent.get('/interns');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/You have no interns yet\. Use the button below to add one\./);
    expect(res.text).toMatch(/href="\/interns\/new"[^>]*>Register Intern</);
    expect(res.text).not.toMatch(/class="tb-bar"/);
  });

  it('GET /interns with interns shows the normal list, not the call to action', async () => {
    const { agent, user: admin } = await makeAdmin(app);
    await User.create({ name: 'Zed Findable', email: 'zed2@example.com', passwordHash: 'x', role: 'intern', supervisor: admin._id, active: true });
    const res = await agent.get('/interns');
    expect(res.text).toMatch(/Zed Findable/);
    expect(res.text).toMatch(/class="tb-bar"/);
    expect(res.text).not.toMatch(/tb-start/);
  });

  it('GET /alumni and /interns search by name or email', async () => {
    const { agent, user: admin } = await makeAdmin(app);
    await User.create({ name: 'Zed Findable', email: 'zed@example.com', passwordHash: 'x', role: 'intern', supervisor: admin._id, active: true });
    await User.create({ name: 'Old Timer', email: 'old@example.com', passwordHash: 'x', role: 'intern', supervisor: admin._id, active: false });
    let res = await agent.get('/interns?q=findable');
    expect(res.text).toMatch(/Zed Findable/);
    res = await agent.get('/interns?q=nomatchhere');
    expect(res.text).toMatch(/No intern matches your search/);
    res = await agent.get('/alumni?q=old%40example');
    expect(res.text).toMatch(/Old Timer/);
    res = await agent.get('/alumni?q=nomatchhere&page=3');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/alumni?q=nomatchhere');
  });

  it('GET /interns/:id and /my-history accept search, status and paging', async () => {
    const { agent, user: admin } = await makeAdmin(app);
    const { user: intern, agent: internAgent } = await makeIntern(app, { supervisor: admin });
    await Task.create({ title: 'Needle task', description: 'd', dueDate: '2099-01-01', assignedTo: intern._id, createdBy: admin._id });
    await Task.create({ title: 'Other task', description: 'd', dueDate: '2099-01-01', assignedTo: intern._id, createdBy: admin._id });
    let res = await agent.get(`/interns/${intern._id}?q=needle`);
    expect(res.text).toMatch(/Needle task/);
    expect(res.text).not.toMatch(/Other task/);
    res = await agent.get(`/interns/${intern._id}?status=overdue&page=9`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/interns/${intern._id}?status=overdue`);
    res = await internAgent.get('/my-history?q=needle');
    expect(res.text).toMatch(/Needle task/);
    expect(res.text).not.toMatch(/Other task/);
  });

  it('pages the lists at 25 and keeps search in the page links', async () => {
    const { agent, user: admin } = await makeAdmin(app);
    const { user: first } = await makeIntern(app, { supervisor: admin });
    const rows = [];
    for (let i = 1; i <= 30; i++) {
      rows.push({ title: `Paged task ${String(i).padStart(2, '0')}`, description: 'd', dueDate: '2099-01-01',
        assignedTo: first._id, createdBy: admin._id, createdAt: new Date(Date.now() - i * 1000) });
    }
    await Task.insertMany(rows);

    // One intern with 30 tasks: a single page, with only their newest 25 shown
    let res = await agent.get('/archive');
    expect(res.text).not.toMatch(/Page 1 of/);
    expect((res.text.match(/Paged task/g) || []).length).toBe(25);
    expect(res.text).toMatch(/Showing the latest 25 of 30 tasks/);
    expect(res.text).toMatch(new RegExp(`/interns/${first._id}\\?back=%2Farchive`)); // the button remembers it came from the Archive

    res = await agent.get(`/interns/${first._id}?back=%2Farchive`);
    expect(res.text).toMatch(/Back to Archive/);
    expect(res.text).toMatch(/back=%2Farchive&amp;page=2/); // the Archive link survives paging
    res = await agent.get(`/interns/${first._id}`);
    expect(res.text).toMatch(/Back to Interns/);

    res = await agent.get(`/interns/${first._id}?q=paged`);
    expect(res.text).toMatch(/Page 1 of 2/);
    expect(res.text).toMatch(/q=paged&amp;page=2/); // search survives in the Next link

    for (let i = 0; i < 30; i++) {
      await User.create({ name: `Pager Person ${i}`, email: `pp${i}@test.com`, passwordHash: 'x', role: 'intern', supervisor: admin._id, active: true });
    }
    res = await agent.get('/interns');
    expect(res.text).toMatch(/Page 1 of 2/);
  });

  it('pages the Archive 25 interns at a time, whatever their task counts', async () => {
    const { agent, user: admin } = await makeAdmin(app);
    const ids = [];
    for (let i = 0; i < 30; i++) {
      const u = await User.create({ name: `Arch Person ${String(i).padStart(2, '0')}`, email: `ap${i}@test.com`, passwordHash: 'x', role: 'intern', supervisor: admin._id, active: true });
      ids.push(u._id);
    }
    // the first intern has 40 tasks, everyone else has 1
    const rows = [];
    for (let n = 0; n < 40; n++) rows.push({ title: `Many ${n}`, description: 'd', dueDate: '2099-01-01', assignedTo: ids[0], createdBy: admin._id });
    ids.slice(1).forEach((id, n) => rows.push({ title: `Single ${n}`, description: 'd', dueDate: '2099-01-01', assignedTo: id, createdBy: admin._id }));
    await Task.insertMany(rows);

    let res = await agent.get('/archive');
    expect(res.text).toMatch(/Page 1 of 2 \(30 interns\)/);
    expect((res.text.match(/class="arch-name"/g) || []).length).toBe(25);
    expect((res.text.match(/Many \d+/g) || []).length).toBe(25); // that intern's list is capped
    res = await agent.get('/archive?page=2');
    expect((res.text.match(/class="arch-name"/g) || []).length).toBe(5);
  });

  it('GET /api/suggest gives quick matches, only for your own data', async () => {
    const { agent, user: admin } = await makeAdmin(app);
    const { user: mine, agent: internAgent } = await makeIntern(app, { supervisor: admin });
    await Task.create({ title: 'Quarterly budget', description: 'd', dueDate: '2099-01-01', assignedTo: mine._id, createdBy: admin._id });
    await Task.create({ title: 'Quarterly notes', description: 'd', dueDate: '2099-01-01', assignedTo: mine._id, createdBy: admin._id });

    let res = await agent.get('/api/suggest?kind=archive&q=quarter');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.label)).toEqual(expect.arrayContaining(['Quarterly budget', 'Quarterly notes']));
    expect(res.body.items[0].url).toMatch(/^\/(tasks|interns)\//);

    res = await agent.get('/api/suggest?kind=archive&q=q'); // too short
    expect(res.body.items).toEqual([]);

    res = await agent.get('/api/suggest?kind=interns&q=' + encodeURIComponent(mine.name.slice(0, 4)));
    expect(res.body.items.map((i) => i.label)).toContain(mine.name);
    res = await agent.get('/api/suggest?kind=alumni&q=' + encodeURIComponent(mine.name.slice(0, 4)));
    expect(res.body.items).toEqual([]); // that intern is still active

    res = await agent.get(`/api/suggest?kind=history&q=budget&internId=${mine._id}`);
    expect(res.body.items.map((i) => i.label)).toEqual(['Quarterly budget']);

    res = await internAgent.get('/api/suggest?kind=history&q=budget'); // an intern searches their own
    expect(res.body.items[0].url).toMatch(/from=history$/);
    res = await internAgent.get('/api/suggest?kind=archive&q=budget'); // but not the supervisor's views
    expect(res.status).toBe(400);

    // another supervisor's data is never returned
    const other = await makeAdmin(app, { email: 'other-admin@test.com' });
    res = await other.agent.get('/api/suggest?kind=archive&q=quarter');
    expect(res.body.items).toEqual([]);
    res = await other.agent.get(`/api/suggest?kind=history&q=budget&internId=${mine._id}`);
    expect(res.body.items).toEqual([]);

    res = await request(app).get('/api/suggest?kind=archive&q=quarter'); // logged out
    expect(res.status).toBe(401);
  });

  it('GET /audit-log?page=2 sends you to the last real page when there is no second page', async () => {
    const { agent } = await makeAdmin(app);
    const res = await agent.get('/audit-log?page=2');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/audit-log?page=1');
  });

  it('GET /alumni lists an intern whose internship has ended', async () => {
    const { agent } = await makeAdmin(app);
    await makeIntern(app, {
      name: 'Past Intern', email: 'past@test.com',
      internshipStartDate: '2020-01-01', internshipEndDate: '2020-06-01',
    });
    // makeIntern always creates an active account (that's its default, for
    // every other test's convenience) — flip this one the way the real
    // deactivation job would, rather than the registration flow.
    await User.updateOne({ email: 'past@test.com' }, { $set: { active: false } });

    const res = await agent.get('/alumni');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Past Intern/);
  });
});

describe('Intern pages render with real content', () => {
  it('GET /intern shows an open task', async () => {
    const { agent: adminAgent, user: admin } = await makeAdmin(app);
    const { agent, user: intern } = await makeIntern(app);
    await Task.create({
      title: 'My open task', description: 'd', dueDate: '2099-01-01',
      assignedTo: intern._id, createdBy: admin._id,
    });

    const res = await agent.get('/intern');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/My open task/);
  });

  it('GET /my-history shows a task regardless of status', async () => {
    const { user: admin } = await makeAdmin(app);
    const { agent, user: intern } = await makeIntern(app);
    await Task.create({
      title: 'Old overdue task', description: 'd', dueDate: '2000-01-01',
      assignedTo: intern._id, createdBy: admin._id,
    });

    const res = await agent.get('/my-history');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Old overdue task/);
  });

  it('an intern who opens a task from My History gets a back link to My History', async () => {
    const { user: admin } = await makeAdmin(app);
    const { agent, user: intern } = await makeIntern(app);
    const task = await Task.create({
      title: 'Back link task', description: 'd', dueDate: '2099-01-01',
      assignedTo: intern._id, createdBy: admin._id,
    });
    const fromHistory = await agent.get(`/tasks/${task._id}?from=history`);
    expect(fromHistory.text).toMatch(/href="\/my-history"[^>]*>← Back to My History/);
    const plain = await agent.get(`/tasks/${task._id}`);
    expect(plain.text).toMatch(/href="\/intern"[^>]*>← Back to My Tasks/);
  });

  it('GET /account shows an intern their supervisor and internship dates', async () => {
    const { agent } = await makeIntern(app);
    const res = await agent.get('/account');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Supervisor[\s\S]*Mrs Admin/);
    expect(res.text).toMatch(/Internship/);
  });

it('clears a stale admin session if the account record no longer exists', async () => {
  const { agent, user } = await makeAdmin(app);
  const pageAgent = (await makeAdmin(app)).agent;
  await User.deleteOne({ _id: user._id });

  const apiRes = await agent.get('/api/tasks');
  expect(apiRes.status).toBe(401);
  expect(apiRes.body.error).toMatch(/session is no longer valid/i);

  const pageRes = await pageAgent.get('/admin');
  expect(pageRes.status).toBe(302);
  expect(pageRes.headers.location).toBe('/login');

  const again = await agent.get('/api/tasks');
  expect(again.status).toBe(401);
  expect(again.body.error).toMatch(/log in first/i);
});
});

describe('Intern progress ring on My History', () => {
  it('shows how many of the intern\'s own tasks are submitted, open and overdue', async () => {
    const { agent, user } = await makeIntern(app);
    const admin = await User.findOne({ email: 'admin@test.com' }); // makeIntern's default supervisor
    const mk = (extra) => Task.create({ title: 't', description: 'd', assignedTo: user._id, createdBy: admin._id, ...extra });
    await mk({ dueDate: '2099-01-01', submission: { submittedAt: new Date(), link: 'https://x.com' } });
    await mk({ dueDate: '2099-02-01' });
    await mk({ dueDate: '2000-01-01' });
    await mk({ dueDate: '2000-02-01' });
    const res = await agent.get('/my-history');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/1 of 4 tasks submitted/);
    expect(res.text).toMatch(/1 open · 2 overdue/);
    expect(res.text).toMatch(/aria-label="Your progress: 1 done, 1 open, 2 overdue"/);
    expect(res.text).toMatch(/>25%<\/text>/);
  });

  it('is not shown before any task has been assigned', async () => {
    const { agent } = await makeIntern(app);
    const res = await agent.get('/my-history');
    expect(res.text).not.toMatch(/Your progress/);
  });
});

describe('Interns pages', () => {
  it('GET /interns lists an active intern with History and Edit links', async () => {
    const { agent } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app, { name: 'Listed Intern', email: 'listed@test.com' });
    const res = await agent.get('/interns');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Listed Intern/);
    expect(res.text).toContain(`/interns/${intern._id}/edit`);
    expect(res.text).toContain('/interns/new');
  });

  it('GET /interns/:id/edit shows the edit form, and the history page does not', async () => {
    const { agent } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app, { name: 'Edit Me', email: 'editme@test.com' });
    const edit = await agent.get(`/interns/${intern._id}/edit`);
    expect(edit.status).toBe(200);
    expect(edit.text).toMatch(/edit-intern-form/);
    const history = await agent.get(`/interns/${intern._id}`);
    expect(history.status).toBe(200);
    expect(history.text).not.toMatch(/edit-intern-form/);
    expect(history.text).not.toMatch(/Resend welcome/);
  });

  it('GET /interns/:id/edit is 404 for an invalid id', async () => {
    const { agent } = await makeAdmin(app);
    const res = await agent.get('/interns/not-an-id/edit');
    expect(res.status).toBe(404);
  });
});

describe('Ended internships', () => {
  it('an intern past their end date cannot log in, even if the daily job has not run yet', async () => {
    // makeIntern tries to log in as part of its setup; with a past end date that login is refused
    const { agent, user } = await makeIntern(app, {
      email: 'ended-login@test.com', internshipStartDate: '2020-01-01', internshipEndDate: '2020-06-01',
    });
    const res = await agent.get('/intern');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
    const fresh = await User.findById(user._id);
    expect(fresh.active).toBe(false);
  });

  it('an intern who is logged in is sent to /login once their account is deactivated', async () => {
    const { agent, user } = await makeIntern(app, { email: 'later-ended@test.com' });
    expect((await agent.get('/intern')).status).toBe(200);
    await User.updateOne({ _id: user._id }, { $set: { active: false } });
    const res = await agent.get('/intern');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});

describe('Back links return to where the supervisor came from', () => {
  it('the intern page and task page go back to the page that linked to them', async () => {
    const { agent, user: admin } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const task = await Task.create({ title: 'Back test', description: 'd', assignedTo: intern._id, createdBy: admin._id, dueDate: '2099-01-01' });

    let res = await agent.get(`/interns/${intern._id}?back=${encodeURIComponent('/admin?page=2#progress')}`);
    expect(res.text).toMatch(/href="\/admin\?page=2#progress"[^>]*>← Back to Dashboard/);

    res = await agent.get(`/tasks/${task._id}?back=${encodeURIComponent('/audit-log?page=3')}`);
    expect(res.text).toMatch(/href="\/audit-log\?page=3"[^>]*>← Back to Audit log/);

    // with no (or an unsafe) back address, the old defaults apply
    res = await agent.get(`/tasks/${task._id}?back=${encodeURIComponent('https://evil.example/')}`);
    expect(res.text).toMatch(/href="\/archive"[^>]*>← Back to Archive/);
    res = await agent.get(`/interns/${intern._id}`);
    expect(res.text).toMatch(/href="\/interns"[^>]*>← Back to Interns/);
  });

  it('links on the dashboard and the audit log carry a back address', async () => {
    const { agent, user: admin } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const task = await Task.create({ title: 'Linked', description: 'd', assignedTo: intern._id, createdBy: admin._id, dueDate: '2099-01-01' });
    const AuditLog = require('../models/AuditLog');
    await AuditLog.create({ action: 'created', supervisor: admin._id, taskId: task._id, taskTitle: 'Linked', performedBy: admin._id, performedByName: admin.name });

    let res = await agent.get('/admin');
    expect(res.text).toMatch(new RegExp(`/interns/${intern._id}\\?back=%2Fadmin%23progress`));
    res = await agent.get('/audit-log');
    expect(res.text).toMatch(new RegExp(`/tasks/${task._id}\\?back=%2Faudit-log`));
  });
});

describe('Task page', () => {
  it('GET /tasks/:id opens for the supervisor who assigned it', async () => {
    const { agent, user: admin } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const task = await Task.create({
      title: 'Open me', description: 'd', dueDate: '2099-01-01',
      assignedTo: intern._id, createdBy: admin._id,
    });
    const res = await agent.get(`/tasks/${task._id}`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Open me/);
  });

  it('GET /tasks/:id shows the assigned intern a submit form, and the supervisor an edit form', async () => {
    const { agent: adminAgent, user: admin } = await makeAdmin(app);
    const { agent: internAgent, user: intern } = await makeIntern(app);
    const task = await Task.create({
      title: 'Hand this in', description: 'd', dueDate: '2099-01-01',
      assignedTo: intern._id, createdBy: admin._id,
    });
    const asIntern = await internAgent.get(`/tasks/${task._id}`);
    expect(asIntern.status).toBe(200);
    expect(asIntern.text).toMatch(/submit-form/);
    expect(asIntern.text).not.toMatch(/edit-form/);
    const asAdmin = await adminAgent.get(`/tasks/${task._id}`);
    expect(asAdmin.text).toMatch(/edit-form/);
    expect(asAdmin.text).toMatch(/delete-btn/);
    expect(asAdmin.text).not.toMatch(/submit-form/);
  });
});

describe('Archive exports', () => {
  it('GET /archive/export.pdf returns a PDF', async () => {
    const { agent } = await makeAdmin(app);
    const res = await agent.get('/archive/export.pdf').buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  it('keeps supported accented text and safely represents unsupported Unicode', () => {
    expect(pdfText('café 李 😀')).toBe('café [U+674E] [U+1F600]');
  });

  it('generates a valid PDF when task content contains unsupported Unicode', async () => {
    const { agent, user: admin } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app, { name: 'Intern 李 😀', email: 'unicode@test.com' });
    await Task.create({
      title: 'Build a résumé 李 😀', description: 'd', dueDate: '2099-01-01',
      assignedTo: intern._id, createdBy: admin._id,
      submission: { submittedAt: new Date(), note: 'Great work 李 😀' },
    });
    const res = await agent.get('/archive/export.pdf').buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });
});

describe("Intern's own record (PDF)", () => {
  const asBuffer = (r, cb) => {
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  };

  it('GET /my-history/export.pdf gives an intern a PDF named after them', async () => {
    const { user: admin } = await makeAdmin(app);
    const { agent, user: intern } = await makeIntern(app);
    await Task.create({ title: 'Mine', description: 'd', dueDate: '2099-01-01', assignedTo: intern._id, createdBy: admin._id });
    const res = await agent.get('/my-history/export.pdf').buffer(true).parse(asBuffer);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/Intern-One-my-record\.pdf/);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });

  it('is for interns only, and only for people who are logged in', async () => {
    const { agent: adminAgent } = await makeAdmin(app);
    const asAdmin = await adminAgent.get('/my-history/export.pdf');
    expect(asAdmin.status).toBe(302);
    expect(asAdmin.headers.location).toBe('/admin');
    const loggedOut = await request(app).get('/my-history/export.pdf');
    expect(loggedOut.status).toBe(302);
    expect(loggedOut.headers.location).toBe('/login');
  });

  it('GET /my-history offers the download only when there is something to download', async () => {
    const { user: admin } = await makeAdmin(app);
    const { agent, user: intern } = await makeIntern(app);
    expect((await agent.get('/my-history')).text).not.toMatch(/my-history\/export\.pdf/);
    await Task.create({ title: 'Mine', description: 'd', dueDate: '2099-01-01', assignedTo: intern._id, createdBy: admin._id });
    expect((await agent.get('/my-history')).text).toMatch(/my-history\/export\.pdf/);
  });
});

describe('GET /healthz', () => {
  it('reports ok once the database is connected', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
