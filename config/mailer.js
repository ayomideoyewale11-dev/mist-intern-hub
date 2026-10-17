// Sends mail through Brevo's REST API (no npm package needed — just a plain
// fetch call). Set these in .env:
//   BREVO_API_KEY=your-api-key           (Settings → SMTP & API → API Keys)
//   BREVO_SENDER_EMAIL=you@example.com   (must be a verified sender in Brevo)
//   BREVO_SENDER_NAME=MIST Intern Hub  (optional — shown as the "from" name)
//   APP_URL=http://localhost:3000        (used to build links in emails)
const configured = Boolean(
  process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL,
);
const senderName = process.env.BREVO_SENDER_NAME || "MIST Intern Hub";
const MAIL_TIMEOUT_MS = 10_000;

const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(
  /\/$/,
  "",
);
const { fmt } = require("./format");

// Never throws — a mail failure (or no mail setup at all) just gets logged
// and the caller's real work (creating a task, saving a submission) still succeeds.
async function sendMail({ to, subject, text }) {
  if (!configured) {
    console.log(
      `[mailer] Not configured — would have sent "${subject}" to ${to}`,
    );
    // Keep local development convenient, but never claim production delivery.
    return process.env.NODE_ENV !== "production";
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAIL_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "api-key": process.env.BREVO_API_KEY,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        sender: { name: senderName, email: process.env.BREVO_SENDER_EMAIL },
        to: [{ email: to }],
        subject,
        textContent: text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Brevo responded ${res.status}: ${body}`);
    }
    return true;
  } catch (err) {
    console.error("[mailer] Failed to send:", err.message);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function sendTaskAssignedEmail(intern, task) {
  const due = fmt(task.dueDate);
  return sendMail({
    to: intern.email,
    subject: `New task: ${task.title}`,
    text: `Hi ${intern.name},\n\nYou've been assigned a new task: "${task.title}".\nDue: ${due}\n\nView it here: ${appUrl}/tasks/${task._id}\n\n— MIST Intern Hub`,
  });
}

function sendDueDateChangedEmail(intern, task) {
  const due = fmt(task.dueDate);
  return sendMail({
    to: intern.email,
    subject: `Due date changed: ${task.title}`,
    text: `Hi ${intern.name},\n\nThe due date for "${task.title}" has changed.\nNew due date: ${due}\n\nView it here: ${appUrl}/tasks/${task._id}\n\n— MIST Intern Hub`,
  });
}

function sendTaskSubmittedEmail(supervisor, intern, task) {
  return sendMail({
    to: supervisor.email,
    subject: `${intern.name} submitted: ${task.title}`,
    text: `Hi ${supervisor.name},\n\n${intern.name} just submitted "${task.title}".\n\nView it here: ${appUrl}/tasks/${task._id}\n\n— MIST Intern Hub`,
  });
}

function sendWelcomeEmail(intern, rawToken, supervisorName) {
  return sendMail({
    to: intern.email,
    subject: "Welcome to MIST Intern Hub",
    text: `Hi ${intern.name},\n\nWelcome! ${supervisorName || "Your supervisor"} has set up your account for the internship programme at the Lagos State Ministry of Innovation, Science & Technology.\n\nThis is where you'll find the tasks you're assigned, submit your work, and see feedback from your supervisor.\n\nFirst, set your password — this link works for 7 days:\n${appUrl}/reset-password/${rawToken}\n\nOnce that's done, you can log in any time at ${appUrl}/login.\n\n— MIST Intern Hub`,
  });
}

function sendPasswordResetEmail(user, rawToken) {
  return sendMail({
    to: user.email,
    subject: "Reset your password",
    text: `Hi ${user.name},\n\nSomeone asked to reset your password. If that was you, use this link within 1 hour:\n\n${appUrl}/reset-password/${rawToken}\n\nIf you didn't request this, you can ignore this email — your password won't change.\n\n— MIST Intern Hub`,
  });
}

function sendFeedbackGivenEmail(intern, task) {
  return sendMail({
    to: intern.email,
    subject: `Feedback on: ${task.title}`,
    text: `Hi ${intern.name},\n\nYour supervisor left feedback on "${task.title}".\n\nView it here: ${appUrl}/tasks/${task._id}\n\n— MIST Intern Hub`,
  });
}

function sendResubmissionRequestedEmail(intern, task, reason) {
  const due = fmt(task.dueDate);
  return sendMail({
    to: intern.email,
    subject: `Please resubmit: ${task.title}`,
    text: `Hi ${intern.name},\n\nYour supervisor has asked you to resubmit "${task.title}".\n\nWhat to change:\n${reason}\n\nNew due date: ${due}\n\nOpen the task here: ${appUrl}/tasks/${task._id}\n\n— MIST Intern Hub`,
  });
}

function sendDueSoonReminderEmail(intern, task) {
  return sendMail({
    to: intern.email,
    subject: `Due tomorrow: ${task.title}`,
    text: `Hi ${intern.name},\n\nJust a reminder — "${task.title}" is due tomorrow.\n\nView it here: ${appUrl}/tasks/${task._id}\n\n— MIST Intern Hub`,
  });
}

function sendOverdueReminderEmail(intern, task) {
  return sendMail({
    to: intern.email,
    subject: `Overdue: ${task.title}`,
    text: `Hi ${intern.name},\n\n"${task.title}" is now overdue and hasn't been submitted. Please submit it as soon as you can, or contact your supervisor if you need more time.\n\nView it here: ${appUrl}/tasks/${task._id}\n\n— MIST Intern Hub`,
  });
}

function sendWeeklySummaryEmail(supervisor, stats) {
  return sendMail({
    to: supervisor.email,
    subject: `Your weekly summary: ${stats.open} open, ${stats.overdue} overdue, ${stats.submitted} submitted`,
    text: `Hi ${supervisor.name},\n\nHere's how your interns' tasks stand this week:\n\n- Open: ${stats.open}\n- Overdue: ${stats.overdue}\n- Submitted: ${stats.submitted}\n\nView the full archive here: ${appUrl}/archive\n\n— MIST Intern Hub`,
  });
}

const fmtDate = fmt;

function sendInternshipEndedEmail(intern) {
  return sendMail({
    to: intern.email,
    subject: "Your internship has ended",
    text: `Hi ${intern.name},\n\nYour internship at the Lagos State Ministry of Innovation, Science & Technology has come to an end${intern.internshipEndDate ? ` (last day: ${fmtDate(intern.internshipEndDate)})` : ""}. Thank you for your work and contribution.\n\nYour MIST Intern Hub account is now closed, so you will no longer be able to log in. If you think this is a mistake, please contact your supervisor.\n\nWe wish you all the best.\n\n— MIST Intern Hub`,
  });
}

// Sent when a supervisor terminates an internship. It states the reason the supervisor wrote.
function sendInternshipTerminatedEmail(intern, supervisorName, reason) {
  const by = supervisorName || "your supervisor";
  return sendMail({
    to: intern.email,
    subject: "Your internship has been terminated",
    text: `Hi ${intern.name},\n\nYour internship at the Lagos State Ministry of Innovation, Science & Technology has been terminated by ${by}.\n\nReason:\n${reason}\n\nYour MIST Intern Hub account is now closed, so you will no longer be able to log in. The work you handed in is kept on record.\n\nIf you have any questions, please speak to ${by} directly.\n\n— MIST Intern Hub`,
  });
}

// Sent when a supervisor restores an intern whose internship had been terminated.
function sendInternshipReactivatedEmail(intern, supervisorName) {
  const by = supervisorName || "Your supervisor";
  return sendMail({
    to: intern.email,
    subject: "Your account has been reactivated",
    text: `Hi ${intern.name},\n\n${by} has reactivated your MIST Intern Hub account, so your internship at the Lagos State Ministry of Innovation, Science & Technology continues.\n\n${intern.internshipEndDate ? `Your internship now runs until ${fmtDate(intern.internshipEndDate)}.\n\n` : ""}You can log in again with your usual email and password: ${appUrl}/login\nIf you have forgotten your password, you can reset it from the login page.\n\nYour earlier tasks and history are still there.\n\n— MIST Intern Hub`,
  });
}

function sendInternshipEndingSoonEmail(intern) {
  return sendMail({
    to: intern.email,
    subject: `Your internship ends on ${fmtDate(intern.internshipEndDate)}`,
    text: `Hi ${intern.name},\n\nYour internship ends on ${fmtDate(intern.internshipEndDate)}, which is your last day. After that your MIST Intern Hub account is closed and you will no longer be able to log in.\n\nBefore then, please:\n- hand in any task that is still open (nothing can be submitted after its due date);\n- download your record as a PDF from My History: ${appUrl}/my-history\n\nIf your internship should continue, ask your supervisor for an extension.\n\n— MIST Intern Hub`,
  });
}

function sendInternshipExtendedEmail(intern, wasInactive) {
  return sendMail({
    to: intern.email,
    subject: "Your internship has been extended",
    text: `Hi ${intern.name},\n\nYour internship has been extended. Your new end date is ${fmtDate(intern.internshipEndDate)}.\n${wasInactive ? "\nYour account is active again, so you can log in and continue here: " + appUrl + "/login\n" : "\nNothing else changes: you can keep using your account as usual.\n"}\n— MIST Intern Hub`,
  });
}

module.exports = {
  sendTaskAssignedEmail,
  sendDueDateChangedEmail,
  sendTaskSubmittedEmail,
  sendWelcomeEmail,
  sendInternshipEndedEmail,
  sendInternshipTerminatedEmail,
  sendInternshipReactivatedEmail,
  sendInternshipExtendedEmail,
  sendInternshipEndingSoonEmail,
  sendPasswordResetEmail,
  sendFeedbackGivenEmail,
  sendResubmissionRequestedEmail,
  sendDueSoonReminderEmail,
  sendOverdueReminderEmail,
  sendWeeklySummaryEmail,
};
