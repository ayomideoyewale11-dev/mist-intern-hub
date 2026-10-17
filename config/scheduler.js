const cron = require("node-cron");
const Task = require("../models/Task");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { DAY_MS } = require("./taskStatus");
const { localDateKey, addDateDays } = require("./dateBoundaries");
const { statusCondition } = require("./listing");
const { terminatedInternIds, hideTasksOf } = require("./terminated");
const mailer = require("./mailer");

// Tasks whose due date falls on tomorrow's calendar date, not yet submitted,
// not yet reminded about. Marks each one as reminded so it's only ever sent once.
async function sendDueSoonReminders() {
  const tomorrowStart = addDateDays(localDateKey(), 1);
  const tomorrowEnd = addDateDays(tomorrowStart, 1);

  const tasks = await Task.find({
    "submission.submittedAt": null, // matches "missing" too
    remindedDueSoon: { $ne: true }, // $ne so older documents without the flag still match
    dueDate: { $gte: tomorrowStart, $lt: tomorrowEnd },
  }).populate("assignedTo", "name email active");

  let sent = 0;
  for (const task of tasks) {
    // Skip deleted interns, and alumni (inactive) who can no longer log in to submit
    if (!task.assignedTo || task.assignedTo.active === false) continue;
    // Claim only if the task still has the due date we loaded. An extension
    // resets this flag, and a stale save must not set it back afterwards.
    const claimed = await Task.updateOne(
      {
        _id: task._id,
        dueDate: task.dueDate,
        "submission.submittedAt": null,
        remindedDueSoon: { $ne: true },
      },
      { $set: { remindedDueSoon: true } },
    );
    if (!claimed.modifiedCount) continue;
    const delivered = await mailer.sendDueSoonReminderEmail(task.assignedTo, task);
    if (!delivered) {
      await Task.updateOne(
        { _id: task._id, dueDate: task.dueDate, remindedDueSoon: true },
        { $set: { remindedDueSoon: false } },
      );
      continue;
    }
    sent++;
  }
  return sent;
}

// Tasks that are overdue (per the same grace period used everywhere else),
// not submitted, not yet reminded. Also a one-shot reminder.
async function sendOverdueReminders() {
  const cutoff = localDateKey();
  const tasks = await Task.find({
    "submission.submittedAt": null,
    remindedOverdue: { $ne: true },
    dueDate: { $lt: cutoff },
  }).populate("assignedTo", "name email active");

  let sent = 0;
  for (const task of tasks) {
    if (!task.assignedTo || task.assignedTo.active === false) continue;
    const claimed = await Task.updateOne(
      {
        _id: task._id,
        dueDate: task.dueDate,
        "submission.submittedAt": null,
        remindedOverdue: { $ne: true },
      },
      { $set: { remindedOverdue: true } },
    );
    if (!claimed.modifiedCount) continue;
    const delivered = await mailer.sendOverdueReminderEmail(task.assignedTo, task);
    if (!delivered) {
      await Task.updateOne(
        { _id: task._id, dueDate: task.dueDate, remindedOverdue: true },
        { $set: { remindedOverdue: false } },
      );
      continue;
    }
    sent++;
  }
  return sent;
}

// Interns whose internship end date has arrived (or already passed, in case
// the server was down that day) are marked inactive — they disappear from
// the "assign a task" list, but their account and task history stay exactly
// as they were. See GET /alumni and GET /interns/:id.
async function deactivateEndedInternships() {
  const interns = await User.find({
    role: "intern",
    active: true,
    // the end date is the intern's LAST day, so it only counts as ended once that whole day is over
    internshipEndDate: { $lt: localDateKey() },
  }).select("_id name email supervisor internshipEndDate");

  const deactivated = [];
  for (const intern of interns) {
    // Recheck the end date in the write itself: a supervisor may have extended
    // the placement after the initial query returned this intern.
    try {
      const updated = await User.findOneAndUpdate(
        {
          _id: intern._id,
          role: "intern",
          active: true,
          internshipEndDate: { $lt: localDateKey() },
        },
        { $set: { active: false } },
        { returnDocument: "after" },
      );
      if (updated) deactivated.push(updated);
    } catch (err) {
      // Keep processing other interns; a later sweep can retry this one.
      console.error(
        `[scheduler] Could not deactivate intern ${intern._id}:`,
        err.message,
      );
    }
  }
  // Awaited (unlike the request handlers' fire-and-forget logging): this runs in
  // the background where nobody is waiting, so there's no reason not to finish
  // the log write before returning. A failure is still only logged, never thrown.
  if (deactivated.length) {
    try {
      await AuditLog.insertMany(
        deactivated.map((i) => ({
          action: "intern-deactivated",
          internId: i._id,
          internName: i.name,
          supervisor: i.supervisor,
          performedByName: "System (internship end date reached)", // no performedBy id — nobody specific did this
        })),
      );
    } catch (err) {
      console.error("[audit] Failed to log action:", err.message);
    }
  }

  // Claim each email atomically, including retries left pending by a failed send.
  const pendingEndEmails = await User.find({
    role: "intern",
    active: false,
    terminatedAt: null,
    internshipEndDate: { $lt: localDateKey() },
    endedEmailSent: { $ne: true },
  }).select("_id name email supervisor internshipEndDate");
  for (const intern of pendingEndEmails) {
    const claimed = await User.findOneAndUpdate(
      {
        _id: intern._id,
        active: false,
        terminatedAt: null,
        internshipEndDate: intern.internshipEndDate,
        endedEmailSent: { $ne: true },
      },
      { $set: { endedEmailSent: true } },
      { returnDocument: "after" },
    );
    if (!claimed) continue;
    const delivered = await mailer.sendInternshipEndedEmail(claimed);
    if (!delivered) {
      await User.updateOne(
        { _id: claimed._id, internshipEndDate: claimed.internshipEndDate, endedEmailSent: true },
        { $set: { endedEmailSent: false } },
      );
    }
  }

  return deactivated.length;
}

// "Your internship ends in a week": sent once to each active intern whose last day
// is within the next 7 days, because once it ends they can no longer log in to hand
// in work or download their record. Interns whose whole placement is 7 days or less
// are skipped (the warning would arrive on day one). Extending the end date resets it.
const ENDING_SOON_DAYS = 7;
async function sendEndingSoonReminders() {
  const interns = await User.find({
    role: "intern",
    active: true,
    remindedEnding: { $ne: true },
    internshipEndDate: {
      $gte: localDateKey(), // includes today, the intern's last day
      $lte: addDateDays(localDateKey(), ENDING_SOON_DAYS),
    },
  });
  let sent = 0;
  for (const intern of interns) {
    const length =
      new Date(intern.internshipEndDate) - new Date(intern.internshipStartDate);
    if (length <= ENDING_SOON_DAYS * DAY_MS) continue;
    const claimed = await User.findOneAndUpdate(
      {
        _id: intern._id,
        active: true,
        internshipEndDate: intern.internshipEndDate,
        remindedEnding: { $ne: true },
      },
      { $set: { remindedEnding: true } },
      { returnDocument: "after" },
    );
    if (!claimed) continue;
    const delivered = await mailer.sendInternshipEndingSoonEmail(claimed);
    if (!delivered) {
      await User.updateOne(
        { _id: claimed._id, internshipEndDate: claimed.internshipEndDate, remindedEnding: true },
        { $set: { remindedEnding: false } },
      );
      continue;
    }
    sent++;
  }
  return sent;
}

// One summary email per supervisor, counting every task they have assigned.
// Safe to trigger twice in the same week (node-cron plus an outside timer):
// each supervisor is "claimed" in the database first, so only one run sends.
const WEEK_GUARD_MS = 7 * 24 * 60 * 60 * 1000;
async function sendWeeklySummaries() {
  const supervisors = await User.find({ role: "admin" });
  let sent = 0;
  for (const supervisor of supervisors) {
    const now = new Date();
    const claimed = await User.findOneAndUpdate(
      {
        _id: supervisor._id,
        $or: [
          { lastWeeklySummaryAt: null },
          {
            lastWeeklySummaryAt: {
              $lte: new Date(now.getTime() - WEEK_GUARD_MS),
            },
          },
        ],
      },
      { $set: { lastWeeklySummaryAt: now } },
    );
    if (!claimed) continue; // already sent this week

    const releaseClaim = () => User.updateOne(
      { _id: supervisor._id, lastWeeklySummaryAt: now },
      { $unset: { lastWeeklySummaryAt: "" } },
    );
    try {
      // Counted in the database, so no task documents are loaded into memory
      const hidden = await terminatedInternIds(supervisor._id); // terminated interns are not counted
      const [open, submitted, overdue] = await Promise.all(
        ["open", "submitted", "overdue"].map((s) =>
          Task.countDocuments({
            createdBy: supervisor._id,
            ...hideTasksOf(hidden),
            ...statusCondition(s),
          }),
        ),
      );
      const delivered = await mailer.sendWeeklySummaryEmail(supervisor, { open, submitted, overdue });
      if (!delivered) {
        await releaseClaim();
        continue;
      }
      sent += 1;
    } catch (err) {
      await User.updateOne(
        { _id: supervisor._id, lastWeeklySummaryAt: now },
        { $unset: { lastWeeklySummaryAt: "" } },
      );
      throw err;
    }
  }
  return sent;
}

// The actual work for each schedule, pulled out so it can be triggered two
// ways: node-cron's in-process timer below, or an external trigger hitting
// POST /api/cron/daily or /weekly (see routes/cronRoutes.js) — needed
// because a free-tier host that spins the app down when idle (e.g. Render's
// free plan) will simply never fire an in-process timer that falls while
// the app is asleep. Both can safely run on the same day: the due-soon/
// overdue reminders are one-shot (see remindedDueSoon/remindedOverdue), so
// triggering the daily job twice never double-sends anything.
async function runDailyJob() {
  const dueSoon = await sendDueSoonReminders();
  const overdue = await sendOverdueReminders();
  const endingSoon = await sendEndingSoonReminders();
  const ended = await deactivateEndedInternships();
  return { dueSoon, overdue, endingSoon, ended };
}

async function runWeeklyJob() {
  const count = await sendWeeklySummaries();
  return { count };
}

// Called once from server.js after mongoose connects. Never called from
// app.js/createApp(), so tests (which build the app directly) never start
// real cron jobs or send real email on a timer.
const TIMEZONE = process.env.APP_TIMEZONE || "Africa/Lagos";

function startScheduler() {
  // Every day at 07:00 Lagos time — due-soon/overdue reminders, and ending internships
  cron.schedule(
    "0 7 * * *",
    async () => {
      try {
        const result = await runDailyJob();
        console.log(
          `[scheduler] Sent ${result.dueSoon} due-soon, ${result.overdue} overdue reminder(s); sent ${result.endingSoon} internship-ending warning(s); deactivated ${result.ended} internship(s).`,
        );
      } catch (err) {
        console.error("[scheduler] Daily job failed:", err.message);
      }
    },
    { timezone: TIMEZONE },
  );

  // Every Monday at 07:00 — weekly summary for each supervisor
  cron.schedule(
    "0 7 * * 1",
    async () => {
      try {
        const result = await runWeeklyJob();
        console.log(
          `[scheduler] Sent ${result.count} weekly summary email(s).`,
        );
      } catch (err) {
        console.error("[scheduler] Weekly job failed:", err.message);
      }
    },
    { timezone: TIMEZONE },
  );

  // Ending internships don't wait for 07:00: check at startup and every 10
  // minutes, so an intern is deactivated shortly after their last day passes.
  const sweep = async () => {
    try {
      const n = await deactivateEndedInternships();
      if (n) console.log(`[scheduler] Deactivated ${n} ended internship(s).`);
    } catch (err) {
      console.error("[scheduler] Ended-internship sweep failed:", err.message);
    }
  };
  sweep();
  cron.schedule("*/10 * * * *", sweep, { timezone: TIMEZONE });

  console.log(
    `[scheduler] Reminder and summary jobs scheduled (time zone: ${TIMEZONE}).`,
  );
}

module.exports = {
  startScheduler,
  sendDueSoonReminders,
  sendOverdueReminders,
  sendWeeklySummaries,
  deactivateEndedInternships,
  sendEndingSoonReminders,
  runDailyJob,
  runWeeklyJob,
};
