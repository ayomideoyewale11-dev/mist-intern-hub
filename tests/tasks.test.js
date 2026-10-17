const { setupTestApp, teardownTestApp, clearDatabase } = require('./testApp');
const { makeAdmin, makeIntern } = require('./helpers');
const Task = require('../models/Task');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const mailer = require('../config/mailer');
const { localDateKey, addDateDays } = require('../config/dateBoundaries');
const dueDateEmailSpy = jest.spyOn(mailer, 'sendDueDateChangedEmail').mockResolvedValue(true);

async function withFailedUserLookup(userId, action) {
  const originalFindById = User.findById;
  let shouldFail = true;
  const findByIdSpy = jest.spyOn(User, 'findById').mockImplementation(function (id, ...args) {
    if (shouldFail && String(id) === String(userId)) {
      shouldFail = false;
      return Promise.reject(new Error('database unavailable'));
    }
    return originalFindById.call(this, id, ...args);
  });
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await action();
  } finally {
    findByIdSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

// Return a stale task to the handler, but commit an intern submission before
// the handler's conditional write runs. This models the interleaving that
// used to allow a just-submitted task to be edited or deleted.
function submitBetweenReadAndWrite(taskId) {
  const findOne = Task.findOne;
  let raced = false;
  Task.findOne = function (...args) {
    const query = findOne.apply(this, args);
    if (raced) return query;
    raced = true;
    return query.then(async (task) => {
      if (task) {
        await Task.updateOne(
          { _id: taskId },
          {
            $set: {
              'submission.link': 'https://github.com/example/repo',
              'submission.submittedAt': new Date(),
            },
          },
        );
      }
      return task;
    });
  };
  return () => { Task.findOne = findOne; };
}

let app;
beforeAll(async () => { app = await setupTestApp(); }, 30000);
afterEach(clearDatabase);
afterAll(async () => {
  dueDateEmailSpy.mockRestore();
  await teardownTestApp();
});

describe('POST /api/tasks', () => {
  it('refuses a due date in the past, but accepts today', async () => {
    const { agent: admin, csrfToken, user: supervisor } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const body = { title: 'x', description: 'x', assignedTo: String(intern._id) };

    let res = await admin.post('/api/tasks').set('X-CSRF-Token', csrfToken).send({ ...body, dueDate: '2000-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/past/i);

    const today = localDateKey().toISOString().slice(0, 10);
    res = await admin.post('/api/tasks').set('X-CSRF-Token', csrfToken).send({ ...body, dueDate: today });
    expect(res.status).toBe(201);

    // moving an existing task's date into the past is refused too
    res = await admin.put(`/api/tasks/${res.body._id}`).set('X-CSRF-Token', csrfToken).send({ dueDate: '2000-01-01' });
    expect(res.status).toBe(400);
  });

  it('rejects an impossible calendar due date instead of normalizing it', async () => {
    const { agent: admin, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const res = await admin.post('/api/tasks').set('X-CSRF-Token', csrfToken).send({
      title: 'Invalid date', description: 'd', dueDate: '2099-02-30', assignedTo: String(intern._id),
    });
    expect(res.status).toBe(400);
    expect(await Task.findOne({ title: 'Invalid date' })).toBeNull();
  });

  it('lets a supervisor assign a task to one intern', async () => {
    const { agent: admin, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);

    const res = await admin.post('/api/tasks').set('X-CSRF-Token', csrfToken).send({
      title: 'Build a login page', description: 'Use the house style.',
      dueDate: '2099-01-01', assignedTo: String(intern._id),
    });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Build a login page');
  });

  it('refuses when an intern tries to create a task', async () => {
    const { agent: intern, csrfToken } = await makeIntern(app);
    const res = await intern.post('/api/tasks').set('X-CSRF-Token', csrfToken).send({
      title: 'x', description: 'x', dueDate: '2099-01-01', assignedTo: 'all',
    });
    expect(res.status).toBe(403);
  });

  it('"assign to all" creates one task per intern, sharing a batchId', async () => {
    const { agent: admin, csrfToken } = await makeAdmin(app);
    await makeIntern(app, { email: 'a@test.com' });
    await makeIntern(app, { email: 'b@test.com' });

    const res = await admin.post('/api/tasks').set('X-CSRF-Token', csrfToken).send({
      title: 'Read the style guide', description: 'See the shared doc.',
      dueDate: '2099-01-01', assignedTo: 'all',
    });
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(2);

    const tasks = await Task.find({ title: 'Read the style guide' });
    expect(tasks).toHaveLength(2);
    expect(tasks[0].batchId).toBeDefined();
    expect(String(tasks[0].batchId)).toBe(String(tasks[1].batchId));
  });

  it('rejects a request with a missing or wrong CSRF token', async () => {
    const { agent: admin, user: intern } = await makeAdmin(app);
    const res = await admin.post('/api/tasks').send({ // no X-CSRF-Token header set
      title: 'x', description: 'x', dueDate: '2099-01-01', assignedTo: String(intern._id),
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/tasks to a hand-picked list of interns', () => {
  it('creates one task for each picked intern and none for the others', async () => {
    const { agent: admin, csrfToken, user: sup } = await makeAdmin(app);
    const { user: a } = await makeIntern(app, { email: 'a@test.com', supervisor: sup });
    const { user: b } = await makeIntern(app, { email: 'b@test.com', supervisor: sup });
    await makeIntern(app, { email: 'c@test.com', supervisor: sup });

    const res = await admin.post('/api/tasks').set('X-CSRF-Token', csrfToken).send({
      title: 'Picked', description: 'x', dueDate: '2099-01-01', assignedTo: [String(a._id), String(b._id)],
    });
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(2);
    expect(await Task.countDocuments({ title: 'Picked' })).toBe(2);
  });

  it('refuses a list that includes another supervisor\'s intern, creating nothing', async () => {
    const { user: owner } = await makeAdmin(app);
    const { user: theirs } = await makeIntern(app, { email: 'theirs@test.com', supervisor: owner });
    const { agent: other, csrfToken, user: sup } = await makeAdmin(app, { email: 'other2@test.com' });
    const { user: mine } = await makeIntern(app, { email: 'mine2@test.com', supervisor: sup });

    const res = await other.post('/api/tasks').set('X-CSRF-Token', csrfToken).send({
      title: 'Mixed', description: 'x', dueDate: '2099-01-01', assignedTo: [String(mine._id), String(theirs._id)],
    });
    expect(res.status).toBe(400);
    expect(await Task.countDocuments({ title: 'Mixed' })).toBe(0);
  });

  it('treats a list of one like a single assignment', async () => {
    const { agent: admin, csrfToken, user: sup } = await makeAdmin(app);
    const { user: a } = await makeIntern(app, { email: 'solo@test.com', supervisor: sup });
    const res = await admin.post('/api/tasks').set('X-CSRF-Token', csrfToken).send({
      title: 'Solo', description: 'x', dueDate: '2099-01-01', assignedTo: [String(a._id)],
    });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Solo');
  });
});

describe('supervisor isolation', () => {
  it('refuses to assign a task to an intern who belongs to a different supervisor', async () => {
    const { user: owner } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app, { supervisor: owner });
    const { agent: other, csrfToken } = await makeAdmin(app, { email: 'other@test.com' });

    const res = await other.post('/api/tasks').set('X-CSRF-Token', csrfToken).send({
      title: 'Sneaky', description: 'x', dueDate: '2099-01-01', assignedTo: String(intern._id),
    });
    expect(res.status).toBe(400);
    expect(await Task.countDocuments({ title: 'Sneaky' })).toBe(0);
  });

  it('"assign to all" only reaches the supervisor\'s own interns', async () => {
    const { user: owner } = await makeAdmin(app);
    await makeIntern(app, { email: 'mine@test.com', supervisor: owner });
    const { user: otherSup } = await makeAdmin(app, { email: 'other@test.com' });
    await makeIntern(app, { email: 'theirs@test.com', supervisor: otherSup });
    const { agent: ownerAgent, csrfToken } = await makeAdmin(app); // log in as the first supervisor

    const res = await ownerAgent.post('/api/tasks').set('X-CSRF-Token', csrfToken).send({
      title: 'Only mine', description: 'x', dueDate: '2099-01-01', assignedTo: 'all',
    });
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(1);
  });

  it('does not show one supervisor\'s tasks to another supervisor', async () => {
    const { agent: ownerAgent, user: owner, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app, { supervisor: owner });
    const created = await ownerAgent.post('/api/tasks').set('X-CSRF-Token', csrfToken).send({
      title: 'Private to owner', description: 'x', dueDate: '2099-01-01', assignedTo: String(intern._id),
    });
    expect(created.status).toBe(201);

    const { agent: other } = await makeAdmin(app, { email: 'other@test.com' });
    const list = await other.get('/api/tasks/archived');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(0);
    expect((await other.get(`/tasks/${created.body._id}`)).status).toBe(404);
  });
});

describe('PUT /api/tasks/:id', () => {
  it('does not edit a task if loading the supervisor fails', async () => {
    const { agent: admin, csrfToken, user: supervisor } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const task = await Task.create({
      title: 'Original title', description: 'd', dueDate: '2099-01-01',
      assignedTo: intern._id, createdBy: supervisor._id,
    });

    const res = await withFailedUserLookup(supervisor._id, () => admin.put(`/api/tasks/${task._id}`)
      .set('X-CSRF-Token', csrfToken).send({ title: 'Changed title' }));

    expect(res.status).toBe(500);
    expect((await Task.findById(task._id)).title).toBe('Original title');
  });

  it('lets a supervisor move the due date', async () => {
    const { agent: admin, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const created = await admin.post('/api/tasks').set('X-CSRF-Token', csrfToken).send({
      title: 'Editable task', description: 'd', dueDate: '2099-01-01', assignedTo: String(intern._id),
    });

    const res = await admin.put(`/api/tasks/${created.body._id}`).set('X-CSRF-Token', csrfToken).send({ dueDate: '2099-06-01' });
    expect(res.status).toBe(200);
    expect(new Date(res.body.dueDate).getFullYear()).toBe(2099);
  });

  it('does not change a due date if loading the intern for notification fails', async () => {
    const { agent: admin, csrfToken, user: supervisor } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const task = await Task.create({
      title: 'Deadline unchanged', description: 'd', dueDate: '2099-01-01',
      assignedTo: intern._id, createdBy: supervisor._id,
    });
    dueDateEmailSpy.mockClear();

    const res = await withFailedUserLookup(intern._id, () => admin.put(`/api/tasks/${task._id}`)
      .set('X-CSRF-Token', csrfToken).send({ dueDate: '2099-06-01' }));

    expect(res.status).toBe(500);
    expect((await Task.findById(task._id)).dueDate).toEqual(new Date('2099-01-01T00:00:00.000Z'));
    expect(dueDateEmailSpy).not.toHaveBeenCalled();
  });

  it('rejects a title over 200 characters', async () => {
    const { agent: admin, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const created = await admin.post('/api/tasks').set('X-CSRF-Token', csrfToken).send({
      title: 'Editable task', description: 'd', dueDate: '2099-01-01', assignedTo: String(intern._id),
    });

    const res = await admin.put(`/api/tasks/${created.body._id}`).set('X-CSRF-Token', csrfToken).send({ title: 'x'.repeat(201) });
    expect(res.status).toBe(400);
  });

  it('rejects a description over 5000 characters', async () => {
    const { agent: admin, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const created = await admin.post('/api/tasks').set('X-CSRF-Token', csrfToken).send({
      title: 'Editable task', description: 'd', dueDate: '2099-01-01', assignedTo: String(intern._id),
    });

    const res = await admin.put(`/api/tasks/${created.body._id}`).set('X-CSRF-Token', csrfToken).send({ description: 'x'.repeat(5001) });
    expect(res.status).toBe(400);
  });

  it('does not edit a task submitted after the initial read', async () => {
    const { agent: admin, csrfToken, user: supervisor } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const task = await Task.create({
      title: 'Still open', description: 'd', dueDate: '2099-01-01',
      assignedTo: intern._id, createdBy: supervisor._id,
    });
    const restore = submitBetweenReadAndWrite(task._id);
    let res;
    try {
      res = await admin.put(`/api/tasks/${task._id}`).set('X-CSRF-Token', csrfToken).send({ title: 'Edited after submit' });
    } finally {
      restore();
    }

    expect(res.status).toBe(409);
    const saved = await Task.findById(task._id);
    expect(saved.title).toBe('Still open');
    expect(saved.submission.submittedAt).toBeDefined();
  });
});

describe('POST /api/tasks (length limits)', () => {
  it('rejects a title over 200 characters at creation', async () => {
    const { agent: admin, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const res = await admin.post('/api/tasks').set('X-CSRF-Token', csrfToken).send({
      title: 'x'.repeat(201), description: 'd', dueDate: '2099-01-01', assignedTo: String(intern._id),
    });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/tasks/batch/:batchId', () => {
  it('does not extend a batch if loading the supervisor fails', async () => {
    const { agent: admin, csrfToken, user: supervisor } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const batchId = new (require('mongoose').Types.ObjectId)();
    const task = await Task.create({
      title: 'Batch unchanged', description: 'd', dueDate: '2099-01-01',
      assignedTo: intern._id, createdBy: supervisor._id, batchId,
    });

    const res = await withFailedUserLookup(supervisor._id, () => admin.put(`/api/tasks/batch/${batchId}`)
      .set('X-CSRF-Token', csrfToken).send({ dueDate: '2099-06-01' }));

    expect(res.status).toBe(500);
    expect((await Task.findById(task._id)).dueDate).toEqual(new Date('2099-01-01T00:00:00.000Z'));
  });

  it('extends every still-open copy of a batch, leaving submitted ones alone', async () => {
    const { agent: admin, csrfToken: adminToken } = await makeAdmin(app);
    const { agent: internA, user: a, csrfToken: aToken } = await makeIntern(app, { email: 'a@test.com' });
    const { user: b } = await makeIntern(app, { email: 'b@test.com' });

    const created = await admin.post('/api/tasks').set('X-CSRF-Token', adminToken).send({
      title: 'Batch task', description: 'd', dueDate: '2099-01-01', assignedTo: 'all',
    });
    expect(created.body.count).toBe(2);

    const taskA = await Task.findOne({ title: 'Batch task', assignedTo: a._id });
    await internA.post(`/api/tasks/${taskA._id}/submission`).set('X-CSRF-Token', aToken).field('link', 'https://github.com/example/repo');

    dueDateEmailSpy.mockClear();
    const res = await admin.put(`/api/tasks/batch/${taskA.batchId}`).set('X-CSRF-Token', adminToken).send({ dueDate: '2099-06-01' });
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1); // only the unsubmitted one was touched
    expect(dueDateEmailSpy).toHaveBeenCalledTimes(1);
    expect(dueDateEmailSpy.mock.calls[0][0].email).toBe(b.email);
    expect(dueDateEmailSpy.mock.calls[0][1].dueDate).toBe('2099-06-01');
  });

  it('does not reset reminders or send notifications when the batch date is unchanged', async () => {
    const { agent: admin, csrfToken, user: supervisor } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const task = await Task.create({
      title: 'Unchanged batch date', description: 'd', dueDate: '2099-01-01',
      assignedTo: intern._id, createdBy: supervisor._id,
      batchId: new (require('mongoose').Types.ObjectId)(),
      remindedDueSoon: true, remindedOverdue: true,
    });

    dueDateEmailSpy.mockClear();
    const auditSpy = jest.spyOn(AuditLog, 'insertMany');
    let res;
    try {
      res = await admin.put(`/api/tasks/batch/${task.batchId}`)
        .set('X-CSRF-Token', csrfToken)
        .send({ dueDate: '2099-01-01' });
    } finally {
      auditSpy.mockRestore();
    }

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(dueDateEmailSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    const saved = await Task.findById(task._id);
    expect(saved.remindedDueSoon).toBe(true);
    expect(saved.remindedOverdue).toBe(true);
  });

  it('does not count or audit a copy submitted after the initial read', async () => {
    const { agent: admin, csrfToken: adminToken, user: supervisor } = await makeAdmin(app);
    const { user: a } = await makeIntern(app, { email: 'race-a@test.com' });
    const { user: b } = await makeIntern(app, { email: 'race-b@test.com' });
    const batchId = new (require('mongoose').Types.ObjectId)();
    const originalDueDate = new Date('2099-01-01T00:00:00.000Z');
    const taskA = await Task.create({
      title: 'Concurrent batch', description: 'd', dueDate: originalDueDate,
      assignedTo: a._id, createdBy: supervisor._id, batchId,
    });
    const taskB = await Task.create({
      title: 'Concurrent batch', description: 'd', dueDate: originalDueDate,
      assignedTo: b._id, createdBy: supervisor._id, batchId,
    });

    const findOneAndUpdate = Task.findOneAndUpdate;
    const updateOne = Task.updateOne;
    let raced = false;
    const updateSpy = jest.spyOn(Task, 'findOneAndUpdate').mockImplementation(function (filter, ...args) {
      if (!raced && String(filter._id) === String(taskA._id)) {
        raced = true;
        return updateOne.call(this, { _id: taskA._id }, {
          $set: { 'submission.link': 'https://example.com', 'submission.submittedAt': new Date() },
        }).then(() => findOneAndUpdate.call(this, filter, ...args));
      }
      return findOneAndUpdate.call(this, filter, ...args);
    });
    const auditSpy = jest.spyOn(AuditLog, 'insertMany').mockResolvedValue([]);
    let auditCalls = [];
    let res;
    try {
      res = await admin.put(`/api/tasks/batch/${batchId}`).set('X-CSRF-Token', adminToken).send({ dueDate: '2099-06-01' });
      auditCalls = auditSpy.mock.calls;
    } finally {
      updateSpy.mockRestore();
      auditSpy.mockRestore();
    }

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    const savedA = await Task.findById(taskA._id);
    const savedB = await Task.findById(taskB._id);
    expect(savedA.submission.submittedAt).toBeDefined();
    expect(savedA.dueDate).toEqual(originalDueDate);
    expect(savedB.dueDate).toEqual(new Date('2099-06-01T00:00:00.000Z'));
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0][0]).toHaveLength(1);
    expect(String(auditCalls[0][0][0].taskId)).toBe(String(taskB._id));
  });
});

describe('POST /api/tasks/:id/submission', () => {
  async function createOpenTask(admin, adminToken, internId, dueDate = '2099-01-01') {
    const res = await admin.post('/api/tasks').set('X-CSRF-Token', adminToken).send({
      title: 'Write a README', description: 'Explain the setup.',
      dueDate, assignedTo: String(internId),
    });
    return res.body._id;
  }

  it('lets the assigned intern submit a link', async () => {
    const { agent: admin, csrfToken: adminToken } = await makeAdmin(app);
    const { agent: intern, user, csrfToken: internToken } = await makeIntern(app);
    const taskId = await createOpenTask(admin, adminToken, user._id);

    const res = await intern.post(`/api/tasks/${taskId}/submission`).set('X-CSRF-Token', internToken).field('link', 'https://github.com/example/repo');
    expect(res.status).toBe(200);
  });

  it('refuses a second submission on the same task', async () => {
    const { agent: admin, csrfToken: adminToken } = await makeAdmin(app);
    const { agent: intern, user, csrfToken: internToken } = await makeIntern(app);
    const taskId = await createOpenTask(admin, adminToken, user._id);

    await intern.post(`/api/tasks/${taskId}/submission`).set('X-CSRF-Token', internToken).field('link', 'https://github.com/example/repo');
    const second = await intern.post(`/api/tasks/${taskId}/submission`).set('X-CSRF-Token', internToken).field('link', 'https://github.com/example/other');
    expect(second.status).toBe(409);
  });

  it('refuses a submission after the due date has passed', async () => {
    const { user: sup } = await makeAdmin(app);
    const { agent: intern, user, csrfToken: internToken } = await makeIntern(app);
    // created directly: the API itself refuses a past due date
    const taskId = (await Task.create({ title: 'Late one', description: 'd', dueDate: '2000-01-01', assignedTo: user._id, createdBy: sup._id }))._id;

    const res = await intern.post(`/api/tasks/${taskId}/submission`).set('X-CSRF-Token', internToken).field('link', 'https://github.com/example/repo');
    expect(res.status).toBe(403);
  });

  it('refuses a submission if the deadline passes after the initial check', async () => {
    const { user: supervisor } = await makeAdmin(app);
    const { agent: intern, user, csrfToken: internToken } = await makeIntern(app);
    const dueDate = localDateKey();
    const task = await Task.create({
      title: 'Due today', description: 'd', dueDate,
      assignedTo: user._id, createdBy: supervisor._id,
    });

    const updateOne = Task.updateOne;
    Task.updateOne = async function (filter, update, options) {
      // Simulate midnight passing after the route's initial deadline check.
      await updateOne.call(this, { _id: task._id }, {
        $set: { dueDate: addDateDays(dueDate, -1) },
      });
      return updateOne.call(this, filter, update, options);
    };
    let res;
    try {
      res = await intern.post(`/api/tasks/${task._id}/submission`)
        .set('X-CSRF-Token', internToken)
        .field('link', 'https://github.com/example/repo');
    } finally {
      Task.updateOne = updateOne;
    }

    expect(res.status).toBe(403);
    const saved = await Task.findById(task._id);
    expect(saved.submission.submittedAt).toBeUndefined();
    expect(saved.dueDate).toEqual(addDateDays(dueDate, -1));
  });

  it('rejects neither a file nor a link being provided', async () => {
    const { agent: admin, csrfToken: adminToken } = await makeAdmin(app);
    const { agent: intern, user, csrfToken: internToken } = await makeIntern(app);
    const taskId = await createOpenTask(admin, adminToken, user._id);

    const res = await intern.post(`/api/tasks/${taskId}/submission`).set('X-CSRF-Token', internToken).field('note', 'just a note');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/tasks/:id/feedback', () => {
  it('does not save feedback if loading the supervisor fails', async () => {
    const { agent: admin, csrfToken: adminToken, user: supervisor } = await makeAdmin(app);
    const { agent: intern, user, csrfToken: internToken } = await makeIntern(app);
    const task = await Task.create({
      title: 'Needs feedback', description: 'd', dueDate: '2099-01-01',
      assignedTo: user._id, createdBy: supervisor._id,
      submission: { link: 'https://github.com/example/repo', submittedAt: new Date() },
    });

    const res = await withFailedUserLookup(supervisor._id, () => admin.post(`/api/tasks/${task._id}/feedback`)
      .set('X-CSRF-Token', adminToken).send({ text: 'Looks good!' }));

    expect(res.status).toBe(500);
    expect((await Task.findById(task._id)).submission.feedback?.text).toBeUndefined();
  });

  it('lets a supervisor leave feedback on a submitted task', async () => {
    const { agent: admin, csrfToken: adminToken } = await makeAdmin(app);
    const { agent: intern, user, csrfToken: internToken } = await makeIntern(app);
    const created = await admin.post('/api/tasks').set('X-CSRF-Token', adminToken).send({
      title: 'Feedback task', description: 'd', dueDate: '2099-01-01', assignedTo: String(user._id),
    });
    await intern.post(`/api/tasks/${created.body._id}/submission`).set('X-CSRF-Token', internToken).field('link', 'https://github.com/example/repo');

    const res = await admin.post(`/api/tasks/${created.body._id}/feedback`).set('X-CSRF-Token', adminToken).send({ text: 'Looks good!' });
    expect(res.status).toBe(200);

    const task = await Task.findById(created.body._id);
    expect(task.submission.feedback.text).toBe('Looks good!');
  });

  it('refuses feedback on a task that has not been submitted yet', async () => {
    const { agent: admin, csrfToken: adminToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const created = await admin.post('/api/tasks').set('X-CSRF-Token', adminToken).send({
      title: 'Open task', description: 'd', dueDate: '2099-01-01', assignedTo: String(intern._id),
    });

    const res = await admin.post(`/api/tasks/${created.body._id}/feedback`).set('X-CSRF-Token', adminToken).send({ text: 'Too early' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/tasks/:id', () => {
  it('does not delete a task if loading the supervisor fails', async () => {
    const { agent: admin, csrfToken, user: supervisor } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const task = await Task.create({
      title: 'Keep this task', description: 'd', dueDate: '2099-01-01',
      assignedTo: intern._id, createdBy: supervisor._id,
    });

    const res = await withFailedUserLookup(supervisor._id, () => admin.delete(`/api/tasks/${task._id}`)
      .set('X-CSRF-Token', csrfToken));

    expect(res.status).toBe(500);
    expect(await Task.findById(task._id)).not.toBeNull();
  });

  it('permanently deletes an open, untouched task', async () => {
    const { agent: admin, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const created = await admin.post('/api/tasks').set('X-CSRF-Token', csrfToken).send({
      title: 'Open task', description: 'd', dueDate: '2099-01-01', assignedTo: String(intern._id),
    });

    const res = await admin.delete(`/api/tasks/${created.body._id}`).set('X-CSRF-Token', csrfToken);
    expect(res.status).toBe(200);
    expect(await Task.findById(created.body._id)).toBeNull();
  });

  it('refuses to delete a submitted task', async () => {
    const { agent: admin, csrfToken: adminToken } = await makeAdmin(app);
    const { agent: intern, user, csrfToken: internToken } = await makeIntern(app);
    const created = await admin.post('/api/tasks').set('X-CSRF-Token', adminToken).send({
      title: 'Submitted task', description: 'd', dueDate: '2099-01-01', assignedTo: String(user._id),
    });
    await intern.post(`/api/tasks/${created.body._id}/submission`).set('X-CSRF-Token', internToken).field('link', 'https://github.com/example/repo');

    const res = await admin.delete(`/api/tasks/${created.body._id}`).set('X-CSRF-Token', adminToken);
    expect(res.status).toBe(403);
    expect(await Task.findById(created.body._id)).not.toBeNull();
  });

  it('refuses to delete an overdue task', async () => {
    const { agent: admin, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const { user: sup } = await makeAdmin(app);
    const overdue = await Task.create({ title: 'Overdue task', description: 'd', dueDate: '2000-01-01', assignedTo: intern._id, createdBy: sup._id });

    const res = await admin.delete(`/api/tasks/${overdue._id}`).set('X-CSRF-Token', csrfToken);
    expect(res.status).toBe(403);
    expect(await Task.findById(overdue._id)).not.toBeNull();
  });

  it('preserves a task submitted after the initial read', async () => {
    const { agent: admin, csrfToken, user: supervisor } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const task = await Task.create({
      title: 'Submit during delete', description: 'd', dueDate: '2099-01-01',
      assignedTo: intern._id, createdBy: supervisor._id,
    });
    const restore = submitBetweenReadAndWrite(task._id);
    let res;
    try {
      res = await admin.delete(`/api/tasks/${task._id}`).set('X-CSRF-Token', csrfToken);
    } finally {
      restore();
    }

    expect(res.status).toBe(403);
    const saved = await Task.findById(task._id);
    expect(saved).not.toBeNull();
    expect(saved.submission.submittedAt).toBeDefined();
  });
});

describe('reminders after an extension', () => {
  it('lets the reminder emails fire again once the due date is moved', async () => {
    const { agent: admin, user: sup, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const task = await Task.create({
      title: 'Extended', description: 'd', dueDate: '2099-01-01', assignedTo: intern._id, createdBy: sup._id,
      remindedDueSoon: true, remindedOverdue: true,
    });
    const res = await admin.put(`/api/tasks/${task._id}`).set('X-CSRF-Token', csrfToken).send({ dueDate: '2099-06-01' });
    expect(res.status).toBe(200);
    const after = await Task.findById(task._id);
    expect(after.remindedDueSoon).toBe(false);
    expect(after.remindedOverdue).toBe(false);
  });

  it('does not reset them when only the title changes', async () => {
    const { agent: admin, user: sup, csrfToken } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const task = await Task.create({
      title: 'Same date', description: 'd', dueDate: '2099-01-01', assignedTo: intern._id, createdBy: sup._id,
      remindedDueSoon: true,
    });
    await admin.put(`/api/tasks/${task._id}`).set('X-CSRF-Token', csrfToken).send({ title: 'New title' });
    expect((await Task.findById(task._id)).remindedDueSoon).toBe(true);
  });
});
