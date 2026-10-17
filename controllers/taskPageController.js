const mongoose = require("mongoose");
const Task = require("../models/Task");
const { taskStatus, STATUS_LABEL } = require("../config/taskStatus");
const { backTarget } = require("../config/listing");
const { fmt } = require("../config/format");
const { inactiveInternIds, hideTasksOf } = require("../config/terminated");

/* GET /tasks/:id — a single task's own page, the way /tour/:slug works on
   Natours: a real URL for one specific record, rendered with its data. */
const show = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res
        .status(404)
        .render("error", {
          title: "Not found",
          message: "This task doesn't exist, or you don't have access to it.",
        });
    }
    const task = await Task.findById(req.params.id)
      .populate("assignedTo", "name email")
      .populate("createdBy", "name");
    const allowed =
      task &&
      ((req.session.role === "admin" &&
        task.createdBy &&
        String(task.createdBy._id) === req.session.userId) ||
        (req.session.role === "intern" &&
          task.assignedTo &&
          String(task.assignedTo._id) === req.session.userId));
    if (!allowed) {
      return res
        .status(404)
        .render("error", {
          title: "Not found",
          message: "This task doesn't exist, or you don't have access to it.",
        });
    }

    const status = taskStatus(task);

    // If this was an "assign to all" task, show how many copies are still
    // open/overdue, so an extension can be given to the whole batch at once
    let batch = null;
    if (task.batchId && status !== "submitted") {
      const hidden = task.createdBy
        ? await inactiveInternIds(task.createdBy._id)
        : []; // same copies a batch extension would change
      const stillOpenCount = await Task.countDocuments({
        batchId: task.batchId,
        "submission.submittedAt": null,
        ...hideTasksOf(hidden),
      });
      if (stillOpenCount > 1)
        batch = { id: task.batchId, count: stillOpenCount };
    }

    res.render("task", {
      title: task.title,
      fromHistory: req.query.from === "history", // an intern who opened this from My History goes back there
      backTo: backTarget(req.query.back, "/archive", "Archive"), // a supervisor goes back to where they came from
      user: { role: req.session.role },
      currentPath: req.path,
      batch,
      task: {
        _id: task._id,
        title: task.title,
        description: task.description,
        dueDateFormatted: fmt(task.dueDate),
        dueDateInput: new Date(task.dueDate).toISOString().slice(0, 10),
        status,
        statusLabel: STATUS_LABEL[status].text,
        assignedToId: task.assignedTo ? String(task.assignedTo._id) : null,
        assignedToName: task.assignedTo
          ? task.assignedTo.name
          : "Unknown intern",
        assignedToEmail: task.assignedTo ? task.assignedTo.email : null,
        assignedByName: task.createdBy ? task.createdBy.name : null,
        submission: task.submission?.submittedAt
          ? {
              submittedAtFormatted: fmt(task.submission.submittedAt),
              file: task.submission.file,
              link: task.submission.link,
              note: task.submission.note,
              feedback: task.submission.feedback?.text
                ? {
                    text: task.submission.feedback.text,
                    givenAtFormatted: fmt(task.submission.feedback.givenAt),
                  }
                : null,
            }
          : null,
        // Earlier attempts that were sent back, oldest first. `index` is what the file download link needs.
        earlier: (task.previousSubmissions || []).map((p, index) => ({
          index,
          submittedAtFormatted: p.submittedAt ? fmt(p.submittedAt) : "",
          reopenedAtFormatted: p.reopenedAt ? fmt(p.reopenedAt) : "",
          reason: p.reason,
          file: p.file?.fileId
            ? { originalName: p.file.originalName || "submission" }
            : null,
          link: p.link,
          note: p.note,
          feedbackText: p.feedback?.text || "",
        })),
        // What the intern is told while a task is waiting for the new version
        resubmitReason:
          !task.submission?.submittedAt && task.previousSubmissions?.length
            ? task.previousSubmissions[task.previousSubmissions.length - 1]
                .reason
            : null,
      },
    });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .render("error", {
        title: "Something went wrong",
        message: "Please try again in a moment.",
      });
  }
};

module.exports = { show };
