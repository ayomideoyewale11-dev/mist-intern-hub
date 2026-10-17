const User = require("../models/User");
const { dateHasPassed } = require("../config/dateBoundaries");

const ENDED_MESSAGE =
  "Your internship has ended, so this account is no longer active.";
const INVALID_SESSION_MESSAGE =
  "Your session is no longer valid. Please log in again.";

// Sessions stop working when their account is removed or its role changes.
// Interns also lose access when deactivated or when their last day has passed.
async function sessionFailureMessage(req) {
  if (req.session.role === "admin") {
    return (await User.exists({ _id: req.session.userId, role: "admin" }))
      ? null
      : INVALID_SESSION_MESSAGE;
  }
  if (req.session.role !== "intern") return INVALID_SESSION_MESSAGE;

  const user = await User.findById(req.session.userId).select(
    "role active internshipEndDate",
  );
  if (!user || user.role !== req.session.role) return INVALID_SESSION_MESSAGE;
  if (user.internshipEndDate && dateHasPassed(user.internshipEndDate))
    return ENDED_MESSAGE;
  if (user.active === false) return INVALID_SESSION_MESSAGE;
  return null;
}

// API guards: used on /api/* routes, return JSON errors
async function requireLogin(req, res, next) {
  if (!req.session.userId)
    return res.status(401).json({ error: "Please log in first." });
  try {
    const message = await sessionFailureMessage(req);
    if (message) {
      return req.session.destroy(() =>
        res.status(401).json({ error: message }),
      );
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.session.role !== role)
      return res.status(403).json({ error: `Only ${role}s can do that.` });
    next();
  };
}

// Page guards: used on view routes, redirect instead of returning JSON
async function requireLoginPage(req, res, next) {
  if (!req.session.userId) return res.redirect("/login");
  try {
    if (await sessionFailureMessage(req)) {
      return req.session.destroy(() => res.redirect("/login"));
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireRolePage(role) {
  return (req, res, next) => {
    if (req.session.role !== role)
      return res.redirect(req.session.role === "admin" ? "/admin" : "/intern");
    next();
  };
}

module.exports = {
  requireLogin,
  requireRole,
  requireLoginPage,
  requireRolePage,
};
