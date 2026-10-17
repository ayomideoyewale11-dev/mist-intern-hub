const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["intern", "admin"], required: true },
    // Only for interns: the supervisor who created them and who sees their tasks.
    // A supervisor only ever sees interns whose `supervisor` is their own id.
    supervisor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // Forgot-password: a hashed, short-lived token. Never store the raw token —
    // only its SHA-256 hash, so a database leak alone can't be used to reset accounts.
    resetTokenHash: String,
    resetTokenExpires: Date,

    // Only meaningful for interns — when their placement starts and ends.
    internshipStartDate: Date,
    internshipEndDate: Date,
    // Set to false automatically once internshipEndDate passes (see
    // config/scheduler.js). An inactive intern disappears from the "assign a
    // task" list, but their account and full task history are kept exactly as
    // they were — nothing is deleted. See GET /alumni.
    active: { type: Boolean, default: true },
    // Interns only: set when a supervisor ends the internship early for a serious reason
    // (see POST /api/auth/interns/:id/terminate). The intern is also made inactive, so they
    // appear under Alumni, marked "Terminated". Cleared again if the supervisor restores them.
    terminatedAt: Date,
    terminationReason: String,
    // Supervisors only: when their weekly summary email was last sent. Stops the
    // summary going out twice in one week if two things trigger the job.
    lastWeeklySummaryAt: Date,
    // Interns only: true once the "your internship ends in a week" email has gone out,
    // so it is sent once. Reset when the end date is moved later.
    remindedEnding: { type: Boolean, default: false },
    // Tracks delivery of the automatic end-of-internship email independently
    // from `active`, so a transient mail failure can be retried by a later sweep.
    endedEmailSent: { type: Boolean, default: false },
  },
  { timestamps: true },
);

userSchema.index({ role: 1, supervisor: 1 });

module.exports = mongoose.model("User", userSchema);
