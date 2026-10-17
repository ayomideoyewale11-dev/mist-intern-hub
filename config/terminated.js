const User = require("../models/User");

// A terminated intern's tasks are hidden from the supervisor's live views (Dashboard, Archive,
// exports, summaries) while the termination stands. Nothing is deleted: restoring the intern
// brings every task straight back. The Alumni page and the audit log still show the intern.

// ids of this supervisor's terminated interns
async function terminatedInternIds(supervisorId) {
  return User.find({
    role: "intern",
    supervisor: supervisorId,
    terminatedAt: { $ne: null },
  }).distinct("_id");
}

// ids of this supervisor's interns who can no longer take part: terminated, or whose internship
// has ended. Used where a task must not be changed, or an email sent, for someone who can't act on it.
async function inactiveInternIds(supervisorId) {
  return User.find({
    role: "intern",
    supervisor: supervisorId,
    active: false,
  }).distinct("_id");
}

// A Task query fragment that leaves those interns' tasks out. Spread it into a filter:
//   Task.find({ createdBy: me, ...hideTasksOf(ids) })
const hideTasksOf = (ids) => (ids.length ? { assignedTo: { $nin: ids } } : {});

module.exports = { terminatedInternIds, inactiveInternIds, hideTasksOf };
