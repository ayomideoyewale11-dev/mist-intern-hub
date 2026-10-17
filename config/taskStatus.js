const DAY_MS = 24 * 60 * 60 * 1000; // a due date lasts until the end of that day
const { dateHasPassed } = require("./dateBoundaries");

function isSubmitted(task) {
  return Boolean(task.submission?.submittedAt);
}

function isOverdue(task) {
  return dateHasPassed(task.dueDate);
}

// True when a due date (or any end-of-day date) has fully passed. The date itself is still allowed.
function isPastDate(d) {
  return dateHasPassed(d);
}

function taskStatus(task) {
  if (isSubmitted(task)) return "submitted";
  if (isOverdue(task)) return "overdue";
  return "open";
}

const STATUS_LABEL = {
  open: { text: "Open — in progress" },
  submitted: { text: "Submitted" },
  overdue: { text: "Overdue — not submitted" },
};

module.exports = {
  DAY_MS,
  isSubmitted,
  isOverdue,
  isPastDate,
  taskStatus,
  STATUS_LABEL,
};
