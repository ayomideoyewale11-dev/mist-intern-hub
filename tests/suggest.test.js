const originalTimezone = process.env.APP_TIMEZONE;
process.env.APP_TIMEZONE = 'America/Los_Angeles';

const { setupTestApp, teardownTestApp, clearDatabase } = require('./testApp');
const { makeAdmin, makeIntern } = require('./helpers');
const Task = require('../models/Task');

let app;
beforeAll(async () => { app = await setupTestApp(); }, 30000);
afterEach(clearDatabase);
afterAll(async () => {
  await teardownTestApp();
  if (originalTimezone === undefined) delete process.env.APP_TIMEZONE;
  else process.env.APP_TIMEZONE = originalTimezone;
});

describe('GET /api/suggest calendar dates', () => {
  it('shows date-only due dates using the configured timezone-safe formatter', async () => {
    const { agent: admin, user: supervisor } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app, { supervisor });
    await Task.create({
      title: 'Timezone date check',
      description: 'd',
      dueDate: '2099-10-18',
      assignedTo: intern._id,
      createdBy: supervisor._id,
    });

    const res = await admin.get(`/api/suggest?kind=history&internId=${intern._id}&q=Timezone`);

    expect(res.status).toBe(200);
    expect(res.body.items[0].sub).toContain('due 18 Oct 2099');
  });
});
