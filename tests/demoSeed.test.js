const {
  getDemoDatabaseUri,
  demoTaskCleanupFilter,
  legacyDemoTaskCleanupFilter,
} = require('../config/demoSeed');
const mongoose = require('mongoose');
const Task = require('../models/Task');
const { setupTestApp, teardownTestApp, clearDatabase } = require('./testApp');

beforeAll(async () => { await setupTestApp(); }, 30000);
afterEach(clearDatabase);
afterAll(teardownTestApp);

describe('demo seed database configuration', () => {
  it('uses DATABASE_LOCAL for demo data', () => {
    expect(getDemoDatabaseUri({
      DATABASE: 'mongodb://production.example/app',
      DATABASE_LOCAL: 'mongodb://localhost/app',
    })).toBe('mongodb://localhost/app');
  });

  it('does not fall back to DATABASE when DATABASE_LOCAL is missing', () => {
    expect(getDemoDatabaseUri({
      DATABASE: 'mongodb://production.example/app',
    })).toBeUndefined();
  });
});

describe('demo task cleanup filter', () => {
  it('removes tasks assigned to demo interns and explicitly marked seed tasks', () => {
    const supervisorId = 'supervisor-id';
    const internId = 'demo-intern-id';

    expect(demoTaskCleanupFilter(supervisorId, [internId])).toEqual({
      $or: [
        { assignedTo: { $in: [internId] }, createdBy: supervisorId },
        { createdBy: supervisorId, demoSeeded: true },
      ],
    });
  });

  it('does not use a title prefix to decide whether a real task is deleted', () => {
    const filter = demoTaskCleanupFilter('supervisor-id', []);

    expect(filter.$or[1]).toEqual({
      createdBy: 'supervisor-id',
      demoSeeded: true,
    });
    expect(filter.$or.some((branch) => 'title' in branch)).toBe(false);
  });

  it('limits legacy cleanup to the exact old seed-task shape and real interns', () => {
    const supervisorId = 'supervisor-id';
    const demoInternId = 'demo-intern-id';

    expect(legacyDemoTaskCleanupFilter(supervisorId, [demoInternId])).toEqual({
      createdBy: supervisorId,
      assignedTo: { $nin: [demoInternId] },
      demoSeeded: { $ne: true },
      title: /^\[Demo\] Task \d+$/,
      description: 'Demo task.',
    });
  });

  it('deletes seeded tasks and preserves a real task with a [Demo] title', async () => {
    const supervisorId = new mongoose.Types.ObjectId();
    const otherSupervisorId = new mongoose.Types.ObjectId();
    const demoInternId = new mongoose.Types.ObjectId();
    const realInternId = new mongoose.Types.ObjectId();
    const taskFields = {
      description: 'Test task',
      dueDate: new Date('2099-01-01T00:00:00.000Z'),
      assignedTo: realInternId,
      createdBy: supervisorId,
    };
    const realTask = await Task.create({
      ...taskFields,
      title: '[Demo] A real task title',
    });
    const seededRealInternTask = await Task.create({
      ...taskFields,
      title: '[Demo] Seeded task',
      demoSeeded: true,
    });
    const taskForDemoIntern = await Task.create({
      ...taskFields,
      title: '[Demo] Demo intern task',
      assignedTo: demoInternId,
    });
    const otherSupervisorTask = await Task.create({
      ...taskFields,
      title: '[Demo] Other supervisor task',
      assignedTo: demoInternId,
      createdBy: otherSupervisorId,
    });
    const legacyTask = await Task.create({
      ...taskFields,
      title: '[Demo] Task 2',
      description: 'Demo task.',
    });

    const result = await Task.deleteMany(
      demoTaskCleanupFilter(supervisorId, [demoInternId]),
    );
    const legacyResult = await Task.deleteMany(
      legacyDemoTaskCleanupFilter(supervisorId, [demoInternId]),
    );

    expect(result.deletedCount + legacyResult.deletedCount).toBe(3);
    expect(await Task.findById(realTask._id)).not.toBeNull();
    expect(await Task.findById(seededRealInternTask._id)).toBeNull();
    expect(await Task.findById(taskForDemoIntern._id)).toBeNull();
    expect(await Task.findById(otherSupervisorTask._id)).not.toBeNull();
    expect(await Task.findById(legacyTask._id)).toBeNull();
  });
});
