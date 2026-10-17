const { setupTestApp, teardownTestApp, clearDatabase } = require('./testApp');
const { makeAdmin, makeIntern } = require('./helpers');
const User = require('../models/User');
const Task = require('../models/Task');
const { localDateKey, addDateDays } = require('../config/dateBoundaries');

const DAY_MS = 24 * 60 * 60 * 1000;

let app;
let scheduler;
const mailer = require('../config/mailer');
beforeAll(async () => {
  app = await setupTestApp();
  scheduler = require('../config/scheduler');
}, 30000);
afterEach(clearDatabase);
afterAll(teardownTestApp);

describe('deactivateEndedInternships', () => {
  it('deactivates an intern whose end date has passed, leaves a future one active', async () => {
    const { user: pastIntern } = await makeIntern(app, {
      email: 'past@test.com', internshipStartDate: '2020-01-01', internshipEndDate: '2020-06-01',
    });
    const { user: futureIntern } = await makeIntern(app, {
      email: 'future@test.com', internshipStartDate: '2026-01-01', internshipEndDate: '2099-01-01',
    });

    await User.updateOne({ _id: pastIntern._id }, { active: true }); // login already deactivates; reset to "not yet swept"

    const count = await scheduler.deactivateEndedInternships();
    expect(count).toBe(1);

    expect((await User.findById(pastIntern._id)).active).toBe(false);
    expect((await User.findById(futureIntern._id)).active).toBe(true);
  });

  it('sends the "internship has ended" email to an intern who is deactivated', async () => {
    const { user } = await makeIntern(app, {
      email: 'bye@test.com', internshipStartDate: '2020-01-01', internshipEndDate: '2020-06-01',
    });
    await User.updateOne({ _id: user._id }, { $set: { active: true, endedEmailSent: false } });
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await scheduler.deactivateEndedInternships();
    const sent = spy.mock.calls.some((c) => String(c[0]).includes('Your internship has ended') && String(c[0]).includes('bye@test.com'));
    spy.mockRestore();
    expect(sent).toBe(true);
  });

  it('retries a failed internship-ended email without deactivating the user again', async () => {
    const { user } = await makeIntern(app, { email: 'retry-ended@test.com' });
    await User.updateOne({ _id: user._id }, {
      $set: { active: false, internshipEndDate: new Date('2020-06-01T00:00:00.000Z') },
    });
    const sendSpy = jest.spyOn(mailer, 'sendInternshipEndedEmail')
      .mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    try {
      expect(await scheduler.deactivateEndedInternships()).toBe(0);
      expect((await User.findById(user._id)).endedEmailSent).toBe(false);
      expect(await scheduler.deactivateEndedInternships()).toBe(0);
      expect(sendSpy).toHaveBeenCalledTimes(2);
      expect((await User.findById(user._id)).endedEmailSent).toBe(true);
    } finally {
      sendSpy.mockRestore();
    }
  });

  it('logs the deactivation with "System" as the actor, not a specific admin', async () => {
    const AuditLog = require('../models/AuditLog');
    const { user: pastIntern } = await makeIntern(app, {
      email: 'past@test.com', internshipStartDate: '2020-01-01', internshipEndDate: '2020-06-01',
    });

    await scheduler.deactivateEndedInternships();

    const entry = await AuditLog.findOne({ action: 'intern-deactivated', internId: pastIntern._id });
    expect(entry).not.toBeNull();
    expect(entry.performedBy).toBeUndefined();
    expect(entry.performedByName).toMatch(/system/i);
  });

  it('does not touch an intern who is already inactive', async () => {
    const { user } = await makeIntern(app, {
      email: 'already@test.com', internshipStartDate: '2020-01-01', internshipEndDate: '2020-06-01',
    });
    await scheduler.deactivateEndedInternships(); // first pass deactivates them
    const count = await scheduler.deactivateEndedInternships(); // second pass should find nothing new
    expect(count).toBe(0);
    expect((await User.findById(user._id)).active).toBe(false);
  });

  it('does not deactivate an intern whose end date is extended during the sweep', async () => {
    const { user } = await makeIntern(app, {
      email: 'extended-during-sweep@test.com', internshipStartDate: '2020-01-01', internshipEndDate: '2020-06-01',
    });
    await User.updateOne({ _id: user._id }, { $set: { active: true } });
    const findOneAndUpdate = User.findOneAndUpdate;
    const extension = new Date('2099-06-01T00:00:00.000Z');
    const spy = jest.spyOn(User, 'findOneAndUpdate').mockImplementation(async function (filter, ...args) {
      await User.updateOne({ _id: user._id }, { $set: { internshipEndDate: extension } });
      return findOneAndUpdate.call(this, filter, ...args);
    });

    try {
      expect(await scheduler.deactivateEndedInternships()).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const updated = await User.findById(user._id);
    expect(updated.active).toBe(true);
    expect(updated.internshipEndDate).toEqual(extension);
  });

  it('continues processing and records successful deactivations after one intern update fails', async () => {
    const { user: failed } = await makeIntern(app, {
      email: 'failed-sweep@test.com', internshipStartDate: '2020-01-01', internshipEndDate: '2020-06-01',
    });
    const { user: succeeded } = await makeIntern(app, {
      email: 'successful-sweep@test.com', internshipStartDate: '2020-01-01', internshipEndDate: '2020-06-01',
    });
    await User.updateMany({ _id: { $in: [failed._id, succeeded._id] } }, { $set: { active: true, endedEmailSent: false } });
    const AuditLog = require('../models/AuditLog');
    await AuditLog.deleteMany({ action: 'intern-deactivated', internId: { $in: [failed._id, succeeded._id] } });

    const findOneAndUpdate = User.findOneAndUpdate;
    const spy = jest.spyOn(User, 'findOneAndUpdate').mockImplementation(function (filter, ...args) {
      if (String(filter._id) === String(failed._id)) {
        return Promise.reject(new Error('temporary database failure'));
      }
      return findOneAndUpdate.call(this, filter, ...args);
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mailSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    let mailCalls = [];

    try {
      expect(await scheduler.deactivateEndedInternships()).toBe(1);
      mailCalls = mailSpy.mock.calls.map(([message]) => String(message));
    } finally {
      spy.mockRestore();
      errorSpy.mockRestore();
      mailSpy.mockRestore();
    }

    expect((await User.findById(failed._id)).active).toBe(true);
    expect((await User.findById(succeeded._id)).active).toBe(false);
    expect(await AuditLog.countDocuments({ action: 'intern-deactivated', internId: succeeded._id })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'intern-deactivated', internId: failed._id })).toBe(0);
    expect(mailCalls.some((message) => message.includes('successful-sweep@test.com'))).toBe(true);
    expect(mailCalls.some((message) => message.includes('failed-sweep@test.com'))).toBe(false);
  });
});

describe('sendEndingSoonReminders', () => {
  const day = (n) => new Date(Date.now() + n * DAY_MS);
  const logged = (spy) => spy.mock.calls.filter((c) => String(c[0]).includes('Your internship ends on')).length;

  it('warns an intern once when their last day is within a week, never twice', async () => {
    const { user } = await makeIntern(app, { email: 'soon@test.com', internshipStartDate: day(-60), internshipEndDate: day(5) });
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    expect(await scheduler.sendEndingSoonReminders()).toBe(1);
    expect(await scheduler.sendEndingSoonReminders()).toBe(0);
    expect(logged(spy)).toBe(1);
    spy.mockRestore();
    expect((await User.findById(user._id)).remindedEnding).toBe(true);
  });

  it('claims an ending-soon reminder atomically when two jobs overlap', async () => {
    await makeIntern(app, { email: 'concurrent-ending@test.com', internshipStartDate: day(-60), internshipEndDate: day(5) });
    const sendSpy = jest.spyOn(mailer, 'sendInternshipEndingSoonEmail').mockResolvedValue(true);
    try {
      const results = await Promise.all([
        scheduler.sendEndingSoonReminders(),
        scheduler.sendEndingSoonReminders(),
      ]);
      expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
      expect(sendSpy).toHaveBeenCalledTimes(1);
    } finally {
      sendSpy.mockRestore();
    }
  });

  it('retries an ending-soon reminder after the mail provider reports failure', async () => {
    const { user } = await makeIntern(app, { email: 'retry-ending@test.com', internshipStartDate: day(-60), internshipEndDate: day(5) });
    const sendSpy = jest.spyOn(mailer, 'sendInternshipEndingSoonEmail')
      .mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    try {
      expect(await scheduler.sendEndingSoonReminders()).toBe(0);
      expect((await User.findById(user._id)).remindedEnding).toBe(false);
      expect(await scheduler.sendEndingSoonReminders()).toBe(1);
      expect((await User.findById(user._id)).remindedEnding).toBe(true);
    } finally {
      sendSpy.mockRestore();
    }
  });

  it('leaves alone an intern whose internship ends later, has ended, or is inactive', async () => {
    await makeIntern(app, { email: 'later@test.com', internshipStartDate: day(-60), internshipEndDate: day(30) });
    const { user: gone } = await makeIntern(app, { email: 'gone@test.com', internshipStartDate: day(-60), internshipEndDate: day(5) });
    await User.updateOne({ _id: gone._id }, { active: false });
    expect(await scheduler.sendEndingSoonReminders()).toBe(0);
  });

  it('skips an intern whose whole placement is a week or less', async () => {
    await makeIntern(app, { email: 'short@test.com', internshipStartDate: day(-2), internshipEndDate: day(4) });
    expect(await scheduler.sendEndingSoonReminders()).toBe(0);
  });

  it('is part of the daily job, and is sent again after the end date is extended', async () => {
    const { agent, csrfToken } = await makeAdmin(app);
    const { user } = await makeIntern(app, { email: 'again@test.com', internshipStartDate: day(-60), internshipEndDate: day(5) });
    expect((await scheduler.runDailyJob()).endingSoon).toBe(1);

    const put = (end) => agent.put(`/api/auth/interns/${user._id}`).set('X-CSRF-Token', csrfToken).send({
      name: user.name, email: user.email, internshipStartDate: day(-60).toISOString().slice(0, 10), internshipEndDate: end,
    });
    expect((await put(day(40).toISOString().slice(0, 10))).status).toBe(200);
    expect((await User.findById(user._id)).remindedEnding).toBe(false);
    expect((await put(day(6).toISOString().slice(0, 10))).status).toBe(200);
    expect((await scheduler.runDailyJob()).endingSoon).toBe(1);
  });
});

describe('sendDueSoonReminders', () => {
  it('reminds once for a task due tomorrow, never twice', async () => {
    const { user: admin } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const tomorrow = addDateDays(localDateKey(), 1);
    await Task.create({
      title: 'Due tomorrow', description: 'd', dueDate: tomorrow,
      assignedTo: intern._id, createdBy: admin._id,
    });

    const first = await scheduler.sendDueSoonReminders();
    expect(first).toBe(1);
    const second = await scheduler.sendDueSoonReminders();
    expect(second).toBe(0); // already reminded, not sent again

    const task = await Task.findOne({ title: 'Due tomorrow' });
    expect(task.remindedDueSoon).toBe(true);
  });

  it('retries a due-soon reminder after a send failure', async () => {
    const { user: admin } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const task = await Task.create({
      title: 'Retry due-soon', description: 'd', dueDate: addDateDays(localDateKey(), 1),
      assignedTo: intern._id, createdBy: admin._id,
    });
    const sendSpy = jest.spyOn(mailer, 'sendDueSoonReminderEmail')
      .mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    try {
      expect(await scheduler.sendDueSoonReminders()).toBe(0);
      expect((await Task.findById(task._id)).remindedDueSoon).toBe(false);
      expect(await scheduler.sendDueSoonReminders()).toBe(1);
      expect((await Task.findById(task._id)).remindedDueSoon).toBe(true);
    } finally {
      sendSpy.mockRestore();
    }
  });

  it('does not remind about a task that is already submitted', async () => {
    const { user: admin } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const tomorrow = addDateDays(localDateKey(), 1);
    await Task.create({
      title: 'Submitted already', description: 'd', dueDate: tomorrow,
      assignedTo: intern._id, createdBy: admin._id,
      submission: { submittedAt: new Date() },
    });

    expect(await scheduler.sendDueSoonReminders()).toBe(0);
  });

  it('does not overwrite an extension reminder reset during the overdue sweep', async () => {
    const { user: admin } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const task = await Task.create({
      title: 'Overdue extended while sweeping', description: 'd', dueDate: new Date(Date.now() - 10 * DAY_MS),
      assignedTo: intern._id, createdBy: admin._id,
    });
    const updateOne = Task.updateOne;
    const extendedDate = addDateDays(localDateKey(), 2);
    const spy = jest.spyOn(Task, 'updateOne').mockImplementation(async function (filter, update, ...args) {
      if (filter.remindedOverdue) {
        await updateOne.call(this, { _id: task._id }, { $set: { dueDate: extendedDate, remindedOverdue: false } });
      }
      return updateOne.call(this, filter, update, ...args);
    });

    try {
      expect(await scheduler.sendOverdueReminders()).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const updated = await Task.findById(task._id);
    expect(updated.dueDate).toEqual(extendedDate);
    expect(updated.remindedOverdue).toBe(false);
  });

  it('does not overwrite an extension reminder reset during the sweep', async () => {
    const { user: admin } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const task = await Task.create({
      title: 'Extended while sweeping', description: 'd', dueDate: addDateDays(localDateKey(), 1),
      assignedTo: intern._id, createdBy: admin._id,
    });
    const updateOne = Task.updateOne;
    const extendedDate = addDateDays(localDateKey(), 2);
    const spy = jest.spyOn(Task, 'updateOne').mockImplementation(async function (filter, update, ...args) {
      if (filter.remindedDueSoon) {
        await updateOne.call(this, { _id: task._id }, { $set: { dueDate: extendedDate, remindedDueSoon: false } });
      }
      return updateOne.call(this, filter, update, ...args);
    });

    try {
      expect(await scheduler.sendDueSoonReminders()).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const updated = await Task.findById(task._id);
    expect(updated.dueDate).toEqual(extendedDate);
    expect(updated.remindedDueSoon).toBe(false);
  });
});

describe('sendOverdueReminders', () => {
  it('reminds once for an overdue, unsubmitted task, never twice', async () => {
    const { user: admin } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app);
    const longPast = new Date(Date.now() - 10 * DAY_MS);
    await Task.create({
      title: 'Long overdue', description: 'd', dueDate: longPast,
      assignedTo: intern._id, createdBy: admin._id,
    });

    const first = await scheduler.sendOverdueReminders();
    expect(first).toBe(1);
    const second = await scheduler.sendOverdueReminders();
    expect(second).toBe(0);

    const task = await Task.findOne({ title: 'Long overdue' });
    expect(task.remindedOverdue).toBe(true);
  });
});

describe('reminders skip inactive (alumni) interns', () => {
  it('sends no due-soon or overdue email to an inactive intern', async () => {
    const { user: admin } = await makeAdmin(app);
    const { user: intern } = await makeIntern(app, {
      email: 'alumni@test.com', internshipStartDate: '2020-01-01', internshipEndDate: '2020-06-01',
    });
    await User.updateOne({ _id: intern._id }, { active: false });
    await Task.create({
      title: 'Soon', description: 'd', dueDate: addDateDays(localDateKey(), 1),
      assignedTo: intern._id, createdBy: admin._id,
    });
    await Task.create({
      title: 'Late', description: 'd', dueDate: new Date(Date.now() - 10 * DAY_MS),
      assignedTo: intern._id, createdBy: admin._id,
    });

    expect(await scheduler.sendDueSoonReminders()).toBe(0);
    expect(await scheduler.sendOverdueReminders()).toBe(0);
    expect((await Task.findOne({ title: 'Soon' })).remindedDueSoon).toBe(false);
    expect((await Task.findOne({ title: 'Late' })).remindedOverdue).toBe(false);
  });
});

describe('sendWeeklySummaries', () => {
  it('sends one summary per supervisor and resolves without throwing', async () => {
    await makeAdmin(app, { email: 'admin-a@test.com' });
    await makeAdmin(app, { email: 'admin-b@test.com' });

    const count = await scheduler.sendWeeklySummaries();
    expect(count).toBe(2);
  });

  it('never sends a supervisor two summaries in the same week', async () => {
    await makeAdmin(app, { email: 'admin-a@test.com' });
    expect(await scheduler.sendWeeklySummaries()).toBe(1);
    expect(await scheduler.sendWeeklySummaries()).toBe(0); // second trigger, same week
  });

  it('retries a weekly summary after the mail provider reports failure', async () => {
    await makeAdmin(app, { email: 'retry-summary@test.com' });
    const supervisor = await User.findOne({ email: 'retry-summary@test.com' });
    const sendSpy = jest.spyOn(mailer, 'sendWeeklySummaryEmail')
      .mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    try {
      expect(await scheduler.sendWeeklySummaries()).toBe(0);
      expect((await User.findById(supervisor._id)).lastWeeklySummaryAt).toBeUndefined();
      expect(await scheduler.sendWeeklySummaries()).toBe(1);
      expect((await User.findById(supervisor._id)).lastWeeklySummaryAt).toBeInstanceOf(Date);
    } finally {
      sendSpy.mockRestore();
    }
  });

  it('sends again once a week has passed', async () => {
    const { user } = await makeAdmin(app, { email: 'admin-a@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { lastWeeklySummaryAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } });
    expect(await scheduler.sendWeeklySummaries()).toBe(1);
  });

  it('does not send again before a full seven days have passed', async () => {
    const { user } = await makeAdmin(app, { email: 'weekly-boundary@test.com' });
    await User.updateOne({ _id: user._id }, { $set: { lastWeeklySummaryAt: new Date(Date.now() - (7 * DAY_MS - 60 * 60 * 1000)) } });
    expect(await scheduler.sendWeeklySummaries()).toBe(0);
  });
});
