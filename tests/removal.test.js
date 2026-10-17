const mongoose = require('mongoose');
const { setupTestApp, teardownTestApp, clearDatabase } = require('./testApp');
const { makeAdmin, makeIntern } = require('./helpers');
const User = require('../models/User');
const Task = require('../models/Task');
const AuditLog = require('../models/AuditLog');
const { saveToGridFS } = require('../middleware/upload');
const { removeIntern, removeSupervisor, handOver } = require('../config/accountRemoval');

let app;
beforeAll(async () => { app = await setupTestApp(); }, 30000);
afterEach(clearDatabase);
afterAll(teardownTestApp);

const files = () => mongoose.connection.db.collection('submissions.files').countDocuments();
const sessionsOf = (id) => mongoose.connection.db.collection('sessions').countDocuments({ session: { $regex: `"userId":"${String(id)}"` } });

async function taskWithFile(supervisor, intern, title) {
  const fileId = await saveToGridFS(Buffer.from('hello'), 'a.txt');
  const earlierId = await saveToGridFS(Buffer.from('earlier'), 'b.txt');
  return Task.create({
    title, description: 'd', dueDate: '2099-01-01', assignedTo: intern._id, createdBy: supervisor._id,
    submission: { link: '', note: '', submittedAt: new Date(), file: { originalName: 'a.txt', fileId, size: 5 } },
    previousSubmissions: [{ file: { originalName: 'b.txt', fileId: earlierId, size: 7 }, submittedAt: new Date() }],
  });
}

describe('removing accounts (scripts/deleteUser.js)', () => {
  it('deletes an intern with their tasks, files and logins, and nobody else', async () => {
    const { user: sup } = await makeAdmin(app);
    const { user: gone } = await makeIntern(app, { name: 'Gone', email: 'gone@test.com' });
    const { user: stays } = await makeIntern(app, { name: 'Stays', email: 'stays@test.com' });
    await taskWithFile(sup, gone, 'Gone task');
    await taskWithFile(sup, stays, 'Staying task');
    await AuditLog.create({ action: 'created', supervisor: sup._id, performedByName: 'x', taskTitle: 'Gone task' });
    expect(await files()).toBe(4);
    expect(await sessionsOf(gone._id)).toBeGreaterThan(0);

    const done = await removeIntern(gone);
    expect(done).toMatchObject({ interns: 1, tasks: 1, files: 2 });
    expect(await User.findById(gone._id)).toBeNull();
    expect(await Task.countDocuments({ assignedTo: gone._id })).toBe(0);
    expect(await files()).toBe(2); // only the staying intern's two files remain
    expect(await sessionsOf(gone._id)).toBe(0);

    expect(await User.findById(stays._id)).not.toBeNull();
    expect(await Task.countDocuments({ assignedTo: stays._id })).toBe(1);
    expect(await AuditLog.countDocuments()).toBe(1); // the audit log is kept
  });

  it('counts and deletes files on stray tasks created by the supervisor', async () => {
    const { user: sup } = await makeAdmin(app);
    const { user: other } = await makeAdmin(app, { email: 'other@test.com', name: 'Other Sup' });
    const { user: theirs } = await makeIntern(app, { email: 'theirs@test.com', supervisor: other });
    await taskWithFile(sup, theirs, 'Stray');

    const { countForSupervisor } = require('../config/accountRemoval');
    await expect(countForSupervisor(sup)).resolves.toMatchObject({ tasks: 1, files: 2 });
    const done = await removeSupervisor(sup);
    expect(done).toMatchObject({ tasks: 1, files: 2 });
    expect(await Task.countDocuments({ title: 'Stray' })).toBe(0);
    expect(await files()).toBe(0);
    expect(await User.findById(theirs._id)).not.toBeNull();
  });

  it('keeps account and task records when uploaded-file deletion fails', async () => {
    const { user: sup } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    await taskWithFile(sup, intern, 'Keep on failure');
    const deleteSpy = jest.spyOn(mongoose.mongo.GridFSBucket.prototype, 'delete')
      .mockRejectedValue(new Error('storage unavailable'));

    await expect(removeIntern(intern)).rejects.toThrow('storage unavailable');
    deleteSpy.mockRestore();
    expect(await User.findById(intern._id)).not.toBeNull();
    expect(await Task.countDocuments({ assignedTo: intern._id })).toBe(1);
  });

  it('deletes a supervisor with their interns, tasks and files, and leaves other supervisors alone', async () => {
    const { user: sup } = await makeAdmin(app);
    const { user: other } = await makeAdmin(app, { email: 'other@test.com', name: 'Other Sup' });
    const { user: mine } = await makeIntern(app, { email: 'mine@test.com' });
    const { user: theirs } = await makeIntern(app, { email: 'theirs@test.com', supervisor: other });
    await taskWithFile(sup, mine, 'Mine');
    await taskWithFile(other, theirs, 'Theirs');

    const done = await removeSupervisor(sup);
    expect(done).toMatchObject({ supervisors: 1, interns: 1, tasks: 1, files: 2 });
    expect(await User.findById(sup._id)).toBeNull();
    expect(await User.findById(mine._id)).toBeNull();
    expect(await sessionsOf(sup._id)).toBe(0);

    expect(await User.findById(other._id)).not.toBeNull();
    expect(await User.findById(theirs._id)).not.toBeNull();
    expect(await Task.countDocuments({ title: 'Theirs' })).toBe(1);
    expect(await files()).toBe(2);
  });
});

describe('handing over to another supervisor (scripts/handOver.js)', () => {
  it('moves interns, tasks and audit history without deleting anything', async () => {
    const { user: from } = await makeAdmin(app);
    const { user: to } = await makeAdmin(app, { email: 'new@test.com', name: 'New Sup' });
    const { agent: internAgent, user: intern } = await makeIntern(app);
    const task = await Task.create({ title: 'T', description: 'd', dueDate: '2099-01-01', assignedTo: intern._id, createdBy: from._id });
    await AuditLog.create({ action: 'created', taskId: task._id, supervisor: from._id, performedByName: 'x' });

    const done = await handOver(from, to);
    expect(done).toMatchObject({ interns: 1, tasks: 1, logs: 1 });
    expect(String((await User.findById(intern._id)).supervisor)).toBe(String(to._id));
    expect(String((await Task.findById(task._id)).createdBy)).toBe(String(to._id));
    expect(await AuditLog.countDocuments({ supervisor: to._id })).toBe(1);
    expect(await AuditLog.countDocuments({ supervisor: from._id })).toBe(0);
    expect((await internAgent.get('/api/tasks')).status).toBe(200); // the intern is not logged out

    // the new supervisor now sees them; the old one's account can be deleted without touching them
    await removeSupervisor(await User.findById(from._id));
    expect(await User.findById(intern._id)).not.toBeNull();
    expect(await Task.findById(task._id)).not.toBeNull();
  });

  it('refuses the same supervisor twice, or a non-supervisor', async () => {
    const { user: sup } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    await expect(handOver(sup, sup)).rejects.toThrow(/different/);
    await expect(handOver(sup, intern)).rejects.toThrow(/supervisors/);
  });
});
