const crypto = require('crypto');
const bcrypt = require('bcrypt');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { hasEnded, publicUser } = require('../config/accounts');
const { validId, validEmail, validDate } = require('../config/validate');
const {
  sendWelcomeEmail, sendInternshipExtendedEmail, sendInternshipTerminatedEmail, sendInternshipReactivatedEmail,
} = require('../config/mailer');

// Every AuditLog.create() call below is intentionally fire-and-forget
// (.catch(...) instead of await) — a logging failure must never break the
// real action (registering an intern, changing a password, etc).

/* POST /api/auth/create-intern — supervisor-only. There is no public
   registration any more: an intern's account only ever exists because their
   supervisor created it, always owned by that supervisor. The
   intern sets their own password via the same emailed-link flow as
   "forgot password" below, just with a longer-lived link (7 days) since a
   welcome email might not be opened right away. */
const create = async (req, res) => {
  try {
    const { name, email, internshipStartDate, internshipEndDate } = req.body;

    if (!name || !email || !internshipStartDate || !internshipEndDate) {
      return res.status(400).json({ error: 'Please fill in the name, email, start date and end date.' });
    }
    if (typeof name !== 'string' || typeof email !== 'string') {
      return res.status(400).json({ error: 'Name and email must be text.' });
    }
    if (!validEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!validDate(internshipStartDate) || !validDate(internshipEndDate)) {
      return res.status(400).json({ error: 'Please enter a valid start date and end date.' });
    }
    const start = new Date(`${internshipStartDate}T00:00:00.000Z`);
    const end = new Date(`${internshipEndDate}T00:00:00.000Z`);
    if (end <= start) {
      return res.status(400).json({ error: 'The internship end date must be after the start date.' });
    }
    if (hasEnded(end)) {
      // Would be deactivated by the daily job within hours, before ever being useful
      return res.status(400).json({ error: 'The internship end date must be in the future.' });
    }

    const admin = await User.findById(req.session.userId);

    // The intern never sees or chooses this — they set their real password
    // via the welcome email's link, the same as a password reset.
    const throwawayPassword = crypto.randomBytes(32).toString('hex');
    const passwordHash = await bcrypt.hash(throwawayPassword, 10);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const intern = await User.create({
      name, email, passwordHash, role: 'intern', supervisor: req.session.userId,
      internshipStartDate: start, internshipEndDate: end,
      resetTokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
      resetTokenExpires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });

    const emailSent = await sendWelcomeEmail(intern, rawToken, admin?.name);

    AuditLog.create({
      action: 'intern-registered', internId: intern._id, internName: intern.name, supervisor: req.session.userId,
      performedBy: req.session.userId, performedByName: admin?.name || 'Unknown',
    }).catch((err) => console.error('[audit] Failed to log action:', err.message));

    res.status(201).json({ ...publicUser(intern), emailSent });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: 'An account with that email already exists.' });
    }
    if (err.name === 'ValidationError') {
      return res.status(400).json({ error: 'Some details are not valid. Check the name and email, then try again.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Could not create account.' });
  }
};

/* PUT /api/auth/interns/:id — supervisor edits an intern's details, or
   flips their active status by hand (e.g. an early termination, or
   extending someone's placement past what the dates alone would allow). */
const update = async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'Intern not found.' });
    const intern = await User.findOne({ _id: req.params.id, role: 'intern', supervisor: req.session.userId });
    if (!intern) return res.status(404).json({ error: 'Intern not found.' });

    const { name, email, internshipStartDate, internshipEndDate, active } = req.body;
    if ((name && typeof name !== 'string') || (email && typeof email !== 'string')) {
      return res.status(400).json({ error: 'Name and email must be text.' });
    }
    if (email && !validEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const wasActive = intern.active;
    const wasTerminated = Boolean(intern.terminatedAt);
    const oldEnd = intern.internshipEndDate ? new Date(intern.internshipEndDate).getTime() : 0;

    if (name) intern.name = name;
    if (email) intern.email = email.toLowerCase().trim();
    if ((internshipStartDate && !validDate(internshipStartDate)) || (internshipEndDate && !validDate(internshipEndDate))) {
      return res.status(400).json({ error: 'Please enter a valid start date and end date.' });
    }
    const newStart = internshipStartDate ? new Date(`${internshipStartDate}T00:00:00.000Z`) : null;
    const newEnd = internshipEndDate ? new Date(`${internshipEndDate}T00:00:00.000Z`) : null;
    if (newStart) intern.internshipStartDate = newStart;
    if (newEnd) intern.internshipEndDate = newEnd;
    if (intern.internshipEndDate <= intern.internshipStartDate) {
      return res.status(400).json({ error: 'The internship end date must be after the start date.' });
    }
    if (typeof active === 'boolean') {
      // The daily job deactivates anyone whose end date has passed, so
      // re-activating such an intern would be silently undone at 7 AM.
      if (active && hasEnded(intern.internshipEndDate)) {
        return res.status(400).json({ error: "This intern's internship end date has already passed. Move the end date forward first to reactivate them." });
      }
      intern.active = active;
      if (active) { intern.terminatedAt = undefined; intern.terminationReason = undefined; } // restored: no longer terminated
    }

    // a later end date means the "ends in a week" warning should be sent again for it
    if (intern.internshipEndDate && new Date(intern.internshipEndDate).getTime() > oldEnd) {
      intern.remindedEnding = false;
      intern.endedEmailSent = false;
    }
    const admin = await User.findById(req.session.userId);
    await intern.save();
    const endMovedLater = intern.internshipEndDate && new Date(intern.internshipEndDate).getTime() > oldEnd;
    if (wasTerminated && intern.active) {
      // Given another chance: one email that covers it (it includes the end date, so no separate "extended" email)
      sendInternshipReactivatedEmail(intern, admin?.name);
    } else if (endMovedLater && intern.active !== false) {
      // Told only when the end date really moves later (not on a name/email edit), and only if
      // they can actually log in: someone still terminated or ended is not told they were extended
      sendInternshipExtendedEmail(intern, wasActive === false && intern.active !== false);
    }

    const action = intern.active !== wasActive
      ? (intern.active ? 'intern-activated' : 'intern-deactivated')
      : 'intern-edited';
    AuditLog.create({
      action, internId: intern._id, internName: intern.name, supervisor: intern.supervisor,
      performedBy: req.session.userId, performedByName: admin?.name || 'Unknown',
      details: wasTerminated && intern.active ? 'Termination reversed: the intern was restored' : undefined,
    }).catch((err) => console.error('[audit] Failed to log action:', err.message));

    res.json(publicUser(intern));
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: 'An account with that email already exists.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Could not update intern.' });
  }
};

/* POST /api/auth/interns/:id/resend-welcome — in case the first welcome
   email never arrived, or its 7-day link already expired. Generates a
   fresh token, invalidating the old one. */
const resendWelcome = async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'Intern not found.' });
    const intern = await User.findOne({ _id: req.params.id, role: 'intern', supervisor: req.session.userId });
    if (!intern) return res.status(404).json({ error: 'Intern not found.' });
    if (intern.active === false) {
      return res.status(400).json({ error: "This intern's internship has ended, so there is no point sending a welcome email. Restore them first if they should log in again." });
    }

    const previousTokenHash = intern.resetTokenHash;
    const previousTokenExpires = intern.resetTokenExpires;
    const rawToken = crypto.randomBytes(32).toString('hex');
    intern.resetTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    intern.resetTokenExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const admin = await User.findById(req.session.userId);
    await intern.save();
    const emailSent = await sendWelcomeEmail(intern, rawToken, admin?.name);
    if (!emailSent) {
      intern.resetTokenHash = previousTokenHash;
      intern.resetTokenExpires = previousTokenExpires;
      await intern.save();
      const previousLinkUsable = previousTokenHash && previousTokenExpires && previousTokenExpires > new Date();
      return res.status(502).json({ error: previousLinkUsable
        ? 'The welcome email could not be sent. The previous setup link remains valid.'
        : 'The welcome email could not be sent, and there is no valid setup link. Please try again.' });
    }

    AuditLog.create({
      action: 'welcome-resent', internId: intern._id, internName: intern.name, supervisor: intern.supervisor,
      performedBy: req.session.userId, performedByName: admin?.name || 'Unknown',
    }).catch((err) => console.error('[audit] Failed to log action:', err.message));

    res.json({ success: true, emailSent: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not resend the welcome email.' });
  }
};

/* POST /api/auth/interns/:id/terminate — a supervisor ends an internship early for a
   serious reason (e.g. misconduct). The intern is made inactive straight away (their
   next click logs them out), their work and history are kept, and the reason is
   recorded in the audit log. The intern is emailed, and the email states the reason.
   It can be undone with the "Active" box on the Edit intern page. */
const terminate = async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'Intern not found.' });
    const intern = await User.findOne({ _id: req.params.id, role: 'intern', supervisor: req.session.userId });
    if (!intern) return res.status(404).json({ error: 'Intern not found.' });
    if (intern.active === false) {
      return res.status(400).json({ error: 'This internship has already ended.' });
    }

    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Please write the reason for ending this internship.' });
    if (reason.length > 500) return res.status(400).json({ error: 'The reason is too long (500 characters max).' });

    intern.active = false;
    intern.terminatedAt = new Date();
    intern.terminationReason = reason;
    const admin = await User.findById(req.session.userId);
    await intern.save();
    sendInternshipTerminatedEmail(intern, admin?.name, reason); // fire-and-forget
    try {
      await AuditLog.create({
      action: 'intern-terminated', internId: intern._id, internName: intern.name, supervisor: intern.supervisor,
      performedBy: req.session.userId, performedByName: admin?.name || 'Unknown',
      details: `Internship terminated. Reason: ${reason}`,
      });
    } catch (auditError) {
      console.error('[audit] Failed to log action:', auditError.message);
    }

    res.json(publicUser(intern));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not end the internship.' });
  }
};

module.exports = { create, update, resendWelcome, terminate };
