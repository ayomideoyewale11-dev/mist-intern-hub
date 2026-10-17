const mongoose = require("mongoose");

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, required: true, maxlength: 5000 },
    dueDate: { type: Date, required: true },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    }, // intern
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    }, // the supervisor who owns this task

    // Set only when a task was created via "assign to all" — every intern's copy
    // shares the same batchId, so they can be found and extended together.
    batchId: mongoose.Schema.Types.ObjectId,

    // Marks tasks created by scripts/seedDemo.js so cleanup never relies on
    // a user-editable title prefix.
    demoSeeded: { type: Boolean, default: false, select: false },

    // (No soft-delete field: deleting an open task removes it permanently.
    // Submitted and overdue tasks can't be deleted at all — see routes/taskRoutes.js)

    // The intern's submission (empty until they submit)
    submission: {
      link: { type: String, maxlength: 500 },
      note: { type: String, maxlength: 1000 },
      file: {
        originalName: String, // shown to users
        fileId: mongoose.Schema.Types.ObjectId, // GridFS file id, never sent to the browser
        size: Number,
      },
      submittedAt: Date,
      // The supervisor's feedback on this submission (empty until given)
      feedback: {
        text: { type: String, maxlength: 1000 },
        givenAt: Date,
      },
    },

    // When a supervisor asks for a resubmission, the old submission (with its
    // feedback and the reason it was sent back) is moved here and `submission`
    // above is cleared. Nothing is deleted: the old files stay in GridFS.
    previousSubmissions: [
      new mongoose.Schema(
        {
          link: String,
          note: String,
          file: {
            originalName: String,
            fileId: mongoose.Schema.Types.ObjectId,
            size: Number,
          },
          submittedAt: Date,
          feedback: { text: String, givenAt: Date },
          reopenedAt: Date,
          reason: String, // what the supervisor asked the intern to change
        },
        { _id: false },
      ),
    ],

    // One-time reminder flags, set by config/scheduler.js so an intern is
    // emailed about a task at most once per phase (never spammed daily)
    remindedDueSoon: { type: Boolean, default: false },
    remindedOverdue: { type: Boolean, default: false },
  },
  { timestamps: true },
);

taskSchema.index({ assignedTo: 1, dueDate: 1 });
taskSchema.index({ createdBy: 1, dueDate: 1 });
taskSchema.index({ assignedTo: 1, createdAt: -1 }); // history pages, newest first
taskSchema.index({ createdBy: 1, createdAt: -1 }); // the Archive, newest first
taskSchema.index({ batchId: 1 });

module.exports = mongoose.model("Task", taskSchema);
