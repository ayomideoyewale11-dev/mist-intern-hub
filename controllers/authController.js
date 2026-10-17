const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { hasEnded, publicUser } = require("../config/accounts");
const { sendPasswordResetEmail } = require("../config/mailer");
const { deactivateEndedInternships } = require("../config/scheduler");
const { validNewPassword, passwordFitsBcrypt } = require("../config/validate");

// Compared against when no account matches an email, so a wrong email takes as long as a wrong
// password and the response time doesn't reveal which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

// Regenerate the session on login/register (prevents session fixation)
function startSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = String(user._id);
      req.session.role = user.role;
      resolve();
    });
  });
}

// Ends every login of this user except (optionally) the current one, e.g. after a
// password change, so a stolen or forgotten login on another device stops working.
async function endOtherSessions(userId, keepSessionId) {
  try {
    const filter = { session: { $regex: `"userId":"${String(userId)}"` } };
    if (keepSessionId) filter._id = { $ne: keepSessionId };
    await mongoose.connection.db.collection("sessions").deleteMany(filter);
  } catch (err) {
    console.error("[sessions] Could not end other sessions:", err.message);
    throw err;
  }
}

/* POST /api/auth/login */
const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email ||
      !password
    ) {
      return res
        .status(400)
        .json({ error: "Email and password are required." });
    }
    if (!passwordFitsBcrypt(password)) {
      return res.status(401).json({
        error:
          "This password is longer than the supported 72 UTF-8 bytes. Use Forgot password to set a new password.",
      });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    const passwordOk = await bcrypt.compare(
      password,
      user ? user.passwordHash : DUMMY_HASH,
    );
    const match = Boolean(user) && passwordOk;
    // One message for "no such account" and "wrong password", on purpose: saying which
    // it was would let anyone test which email addresses are registered here.
    if (!match) {
      return res.status(401).json({
        error:
          "We couldn't log you in with those details. Check your email and password. If you are an intern, your supervisor must register you before you can log in.",
      });
    }

    // Checked only after the password is confirmed correct, so a wrong
    // guess never reveals whether an account has been deactivated.
    if (user.role === "intern") {
      // The daily job (07:00) is what normally flips `active` to false, but it only
      // runs if the server happens to be on at that time. So the end date is checked
      // here too, and the job's own function is run on the spot to tidy up.
      if (user.active && hasEnded(user.internshipEndDate)) {
        await deactivateEndedInternships();
        const current = await User.findById(user._id);
        if (!current) {
          return res.status(401).json({
            error: "We couldn't log you in with those details. Check your email and password. If you are an intern, your supervisor must register you before you can log in.",
          });
        }
        user.active = current.active && !hasEnded(current.internshipEndDate);
        user.internshipEndDate = current.internshipEndDate;
        user.terminatedAt = current.terminatedAt;
      }
    }
    if (user.role === "intern" && !user.active && user.terminatedAt) {
      return res
        .status(403)
        .json({
          error:
            "Your internship has been terminated by your supervisor, so this account is no longer active. Please speak to your supervisor.",
        });
    }
    if (user.role === "intern" && !user.active) {
      return res
        .status(403)
        .json({
          error:
            "Your internship has ended, so this account is no longer active. Contact your supervisor if you believe this is a mistake.",
        });
    }

    await startSession(req, user);
    res.json(publicUser(user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not log in." });
  }
};

/* POST /api/auth/logout */
const logout = (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("[sessions] Could not end session:", err.message);
      return res.status(500).json({ error: "Could not log out." });
    }
    res.clearCookie("mist.sid");
    res.json({ success: true });
  });
};

/* GET /api/auth/me */
const me = (req, res) => {
  if (!req.session.userId)
    return res.status(401).json({ error: "Not logged in." });
  res.json({ id: req.session.userId, role: req.session.role });
};

/* POST /api/auth/forgot-password
   Always responds with the same generic message, whether or not that email
   exists — otherwise the response itself would reveal which emails are
   registered. Only a hash of the token is stored, never the raw token. */
const forgotPassword = async (req, res) => {
  const GENERIC = {
    message: "If that email has an account, we've sent a reset link.",
  };
  try {
    const email =
      typeof req.body.email === "string"
        ? req.body.email.toLowerCase().trim()
        : "";
    if (!email) return res.status(400).json({ error: "Email is required." });

    const user = await User.findOne({ email });
    // An intern whose internship has ended can't log in anyway, so no email is sent (same reply either way)
    if (user && !(user.role === "intern" && user.active === false)) {
      const rawToken = crypto.randomBytes(32).toString("hex");
      const previousResetTokenHash = user.resetTokenHash;
      const previousResetTokenExpires = user.resetTokenExpires;
      user.resetTokenHash = crypto
        .createHash("sha256")
        .update(rawToken)
        .digest("hex");
      user.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await user.save();
      const sent = await sendPasswordResetEmail(user, rawToken);
      if (!sent) {
        // Keep a previously issued link usable if this delivery attempt failed.
        const set = {};
        const unset = {};
        if (previousResetTokenHash) set.resetTokenHash = previousResetTokenHash;
        else unset.resetTokenHash = "";
        if (previousResetTokenExpires) set.resetTokenExpires = previousResetTokenExpires;
        else unset.resetTokenExpires = "";
        await User.updateOne(
          { _id: user._id, resetTokenHash: user.resetTokenHash },
          { ...(Object.keys(set).length && { $set: set }), ...(Object.keys(unset).length && { $unset: unset }) },
        );
      }
    }
    res.json(GENERIC);
  } catch (err) {
    console.error(err);
    res.json(GENERIC); // still generic, even on an unexpected error
  }
};

/* POST /api/auth/reset-password/:token */
const resetPassword = async (req, res) => {
  try {
    const { password } = req.body;
    if (!validNewPassword(password)) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters and no more than 72 UTF-8 bytes." });
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(req.params.token)
      .digest("hex");
    const user = await User.findOne({
      resetTokenHash: tokenHash,
      resetTokenExpires: { $gt: new Date() },
    });
    if (!user)
      return res
        .status(400)
        .json({ error: "This reset link is invalid or has expired." });

    user.passwordHash = await bcrypt.hash(password, 10);
    user.resetTokenHash = undefined;
    user.resetTokenExpires = undefined;
    await user.save();
    await endOtherSessions(user._id); // a reset means the old password may be compromised
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not reset password." });
  }
};

/* POST /api/auth/change-password — for someone already logged in who just
   wants to update their password, as opposed to the "forgot password" flow
   above, which is for someone who's locked out. */
const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (
      typeof currentPassword !== "string" ||
      typeof newPassword !== "string"
    ) {
      return res
        .status(400)
        .json({ error: "Both your current and new password are required." });
    }
    if (!validNewPassword(newPassword)) {
      return res
        .status(400)
        .json({ error: "New password must be at least 8 characters and no more than 72 UTF-8 bytes." });
    }

    const user = await User.findById(req.session.userId);
    const match =
      user && (await bcrypt.compare(currentPassword, user.passwordHash));
    if (!match)
      return res.status(401).json({ error: "Current password is incorrect." });

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await user.save();
    await endOtherSessions(user._id, req.sessionID); // keep this device logged in, end the rest

    AuditLog.create({
      action: "password-changed",
      internId: user._id,
      internName: user.name,
      supervisor: user.supervisor || user._id,
      performedBy: user._id,
      performedByName: user.name,
    }).catch((err) =>
      console.error("[audit] Failed to log action:", err.message),
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not change password." });
  }
};

module.exports = {
  login,
  logout,
  me,
  forgotPassword,
  resetPassword,
  changePassword,
};
