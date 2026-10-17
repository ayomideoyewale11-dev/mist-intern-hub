const mongoose = require("mongoose");

// Names are stored alongside the IDs (denormalized) so the log still reads
// correctly even if a task is deleted or a user record changes later.
// Covers two kinds of events: task actions (taskId/taskTitle set) and
// account actions (internId/internName set) — an entry only ever has one
// pair filled in, never both.
const auditLogSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: [
        "created",
        "edited",
        "batch-extended",
        "deleted",
        "submitted",
        "feedback-given",
        "reopened", // task actions
        "intern-registered",
        "intern-edited",
        "intern-activated",
        "intern-deactivated",
        "intern-terminated", // account actions
        "welcome-resent",
        "password-changed",
      ],
      required: true,
    },
    taskId: mongoose.Schema.Types.ObjectId,
    taskTitle: String,
    internId: mongoose.Schema.Types.ObjectId,
    internName: String,
    supervisor: { type: mongoose.Schema.Types.ObjectId, required: true }, // whose audit log this entry belongs to
    performedBy: mongoose.Schema.Types.ObjectId, // absent for an automated/system action
    performedByName: { type: String, required: true },
    details: String, // short human-readable extra context, e.g. "due date moved to 12 Dec 2026"
  },
  { timestamps: true },
);

auditLogSchema.index({ supervisor: 1, createdAt: -1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
