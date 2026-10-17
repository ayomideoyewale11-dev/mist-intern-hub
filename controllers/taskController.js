const mongoose = require("mongoose");
const Task = require("../models/Task");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const {
  isOverdue,
  isSubmitted,
  isPastDate,
} = require("../config/taskStatus");
const { localDateKey } = require("../config/dateBoundaries");
const { validId, validDate } = require("../config/validate");
const { fmt } = require("../config/format");
const {
  terminatedInternIds,
  inactiveInternIds,
  hideTasksOf,
} = require("../config/terminated");
const {
  sendTaskAssignedEmail,
  sendDueDateChangedEmail,
  sendFeedbackGivenEmail,
  sendResubmissionRequestedEmail,
} = require("../config/mailer");

// Sends emails one after another instead of all at the same moment, so a task
// given to 100+ interns doesn't hit the email provider's rate limit and lose
// some of them. It runs in the background: nothing waits for it, and
// sendMail never throws (the try/catch is just a safety net).
function sendInOrder(items, send) {
  (async () => {
    for (const item of items) {
      try {
        await send(item);
      } catch (err) {
        console.error("[mailer] Failed to send:", err.message);
      }
    }
  })();
}

// Every AuditLog.create() call below is intentionally fire-and-forget
// (.catch(...) instead of await) — a logging failure must never break the
// real action (creating a task, deleting one, submitting, etc).

const MAX_ATTEMPTS = 20; // times one task can be sent back for resubmission

/* A task is "live" (shows on the intern's page) only while it hasn't been
   submitted AND its due date hasn't passed. The moment either happens it drops
   off on its own — nothing has to run in the background to make that happen,
   it's just what this filter matches at read time. Once a task isn't live any
   more it's a permanent record, visible only on the supervisor's Archive page. */
function liveFilter(base) {
  return {
    ...base,
    "submission.submittedAt": null,
    dueDate: { $gte: localDateKey() },
  };
}

/* GET /api/tasks — LIVE tasks only.
   intern: their own; admin (supervisor): all they have assigned */
const list = async (req, res) => {
  try {
    const base =
      req.session.role === "intern"
        ? { assignedTo: req.session.userId }
        : {
            createdBy: req.session.userId,
            ...hideTasksOf(await terminatedInternIds(req.session.userId)),
          };

    const tasks = await Task.find(liveFilter(base))
      .select("-submission.file.fileId -previousSubmissions")
      .populate("assignedTo", "name email")
      .sort({ dueDate: 1 });

    res.json(tasks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load tasks." });
  }
};

/* GET /api/tasks/archived — supervisor-only: EVERY task this supervisor has
   assigned (open, submitted, or overdue), newest first — the permanent record. */
const archived = async (req, res) => {
  try {
    const hidden = await terminatedInternIds(req.session.userId);
    const tasks = await Task.find({
      createdBy: req.session.userId,
      ...hideTasksOf(hidden),
    })
      .select("-submission.file.fileId -previousSubmissions")
      .populate("assignedTo", "name email")
      .sort({ createdAt: -1 }); // newest given first, oldest last
    res.json(tasks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the archive." });
  }
};

/* GET /api/tasks/interns — supervisor-only, for the "assign to" dropdown */
const internsForPicker = async (req, res) => {
  try {
    const interns = await User.find({
      role: "intern",
      supervisor: req.session.userId,
      active: { $ne: false },
    }).select("name email");
    res.json(interns);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load interns." });
  }
};

/* POST /api/tasks — a new task is a live record from the moment it's assigned;
   it also appears on the Archive page straight away (see GET /archived above),
   and later moves there permanently once it's submitted or goes overdue. */
const create = async (req, res) => {
  try {
    const { title, description, dueDate } = req.body;
    let { assignedTo } = req.body; // 'all', one intern id, or a list of intern ids
    if (!title || !description || !dueDate || !assignedTo) {
      return res
        .status(400)
        .json({
          error:
            "Please fill in the title, description and due date, and choose at least one intern.",
        });
    }
    if (typeof title !== "string" || typeof description !== "string") {
      return res
        .status(400)
        .json({ error: "Title and description must be text." });
    }
    if (title.length > 200)
      return res
        .status(400)
        .json({ error: "Title is too long (200 characters max)." });
    if (description.length > 5000)
      return res
        .status(400)
        .json({ error: "Description is too long (5000 characters max)." });
    if (!validDate(dueDate))
      return res.status(400).json({ error: "Please choose a valid due date." });
    if (isPastDate(dueDate))
      return res
        .status(400)
        .json({ error: "The due date cannot be in the past." });

    const supervisor = await User.findById(req.session.userId);

    // "all" or a list = one copy of the task for each of those interns
    let interns = null; // set when the task goes to several interns at once
    if (assignedTo === "all") {
      interns = await User.find({
        role: "intern",
        supervisor: req.session.userId,
        active: { $ne: false },
      }).select("name email");
      if (!interns.length)
        return res
          .status(400)
          .json({ error: "You have no active interns yet." });
    } else if (Array.isArray(assignedTo)) {
      // A hand-picked list of interns (the checkboxes on the dashboard)
      const ids = [...new Set(assignedTo.map(String))];
      if (!ids.length || ids.length > 500 || !ids.every(validId))
        return res
          .status(400)
          .json({ error: "Please choose a valid intern from the list." });
      if (ids.length === 1) {
        assignedTo = ids[0]; // just one: handled by the single-intern path below
      } else {
        interns = await User.find({
          _id: { $in: ids },
          role: "intern",
          supervisor: req.session.userId,
          active: { $ne: false },
        }).select("name email");
        if (interns.length !== ids.length) {
          return res
            .status(400)
            .json({
              error:
                "One of those interns is not yours, or their internship has ended.",
            });
        }
      }
    }
    if (interns) {
      const batchId = new mongoose.Types.ObjectId(); // links every copy for batch extensions later
      const created = await Task.insertMany(
        interns.map((i) => ({
          title,
          description,
          dueDate,
          batchId,
          assignedTo: i._id,
          createdBy: req.session.userId,
        })),
      );

      sendInOrder(
        created.map((task, i) => ({ intern: interns[i], task })),
        ({ intern, task }) => sendTaskAssignedEmail(intern, task),
      );
      created.forEach((task, i) => {
        AuditLog.create({
          action: "created",
          taskId: task._id,
          taskTitle: task.title,
          supervisor: task.createdBy,
          performedBy: req.session.userId,
          performedByName: supervisor?.name || "Unknown",
          details: `Assigned to ${interns[i].name} (part of a batch of ${interns.length})`,
        }).catch((err) =>
          console.error("[audit] Failed to log action:", err.message),
        );
      });
      return res.status(201).json({ count: interns.length });
    }

    if (!validId(assignedTo))
      return res
        .status(400)
        .json({ error: "Please choose a valid intern from the list." });
    const intern = await User.findOne({
      _id: assignedTo,
      role: "intern",
      supervisor: req.session.userId,
      active: { $ne: false },
    });
    if (!intern)
      return res
        .status(400)
        .json({
          error:
            "That intern is not one of yours, or their internship has ended.",
        });

    const task = await Task.create({
      title,
      description,
      dueDate,
      assignedTo,
      createdBy: req.session.userId,
    });
    sendTaskAssignedEmail(intern, task); // fire-and-forget
    AuditLog.create({
      action: "created",
      taskId: task._id,
      taskTitle: task.title,
      supervisor: task.createdBy,
      performedBy: req.session.userId,
      performedByName: supervisor?.name || "Unknown",
      details: `Assigned to ${intern.name}`,
    }).catch((err) =>
      console.error("[audit] Failed to log action:", err.message),
    );
    res.status(201).json(task);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create task." });
  }
};

/* PUT /api/tasks/batch/:batchId — supervisor-only: extend the due date for
   every still-open or overdue copy of a task assigned via "all" in one go.
   Submitted copies are left untouched, since they're a permanent record. */
const extendBatch = async (req, res) => {
  try {
    if (!validId(req.params.batchId))
      return res.status(404).json({ error: "Batch not found." });
    const { dueDate } = req.body;
    if (!validDate(dueDate))
      return res.status(400).json({ error: "Please choose a valid due date." });
    if (isPastDate(dueDate))
      return res
        .status(400)
        .json({ error: "The due date cannot be in the past." });

    // a copy belonging to an intern who is no longer here (terminated, or internship ended) is
    // left alone: no new date, no email, since they can't submit it any more
    const hidden = await inactiveInternIds(req.session.userId);
    const tasks = await Task.find({
      batchId: req.params.batchId,
      createdBy: req.session.userId,
      "submission.submittedAt": null,
      ...hideTasksOf(hidden),
    })
      .select("_id title createdBy assignedTo dueDate")
      .populate("assignedTo", "name email");
    if (!tasks.length)
      return res.status(404).json({ error: "Batch not found." });

    const changedTasks = tasks.filter(
      (task) => localDateKey(task.dueDate).toISOString().slice(0, 10) !== dueDate,
    );
    if (!changedTasks.length) return res.json({ count: 0 });

    const supervisor = await User.findById(req.session.userId);
    const updatedTasks = [];
    for (const task of changedTasks) {
      const updated = await Task.findOneAndUpdate(
        {
          _id: task._id,
          batchId: req.params.batchId,
          createdBy: req.session.userId,
          "submission.submittedAt": null,
          dueDate: { $ne: new Date(dueDate) },
          ...hideTasksOf(hidden),
        },
        { $set: { dueDate, remindedDueSoon: false, remindedOverdue: false } },
        { returnDocument: "after", runValidators: true },
      ); // the submission state is checked again atomically before extending
      if (updated) updatedTasks.push({ ...task.toObject(), dueDate: updated.dueDate });
    }
    if (!updatedTasks.length)
      return res.status(409).json({
        error: "These tasks just changed. Reload the page and try again.",
      });

    const detail = `Batch-extended to ${fmt(dueDate)} (${updatedTasks.length} task(s))`;
    AuditLog.insertMany(
      updatedTasks.map((t) => ({
        action: "batch-extended",
        taskId: t._id,
        taskTitle: t.title,
        supervisor: t.createdBy,
        performedBy: req.session.userId,
        performedByName: supervisor?.name || "Unknown",
        details: detail,
      })),
    ).catch((err) =>
      console.error("[audit] Failed to log action:", err.message),
    );

    sendInOrder(
      updatedTasks.filter((t) => t.assignedTo),
      (t) =>
        sendDueDateChangedEmail(t.assignedTo, { ...t, dueDate }),
    );

    res.json({ count: updatedTasks.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update the batch." });
  }
};

/* PUT /api/tasks/:id — supervisor edits a task (e.g. gives an extension by
   moving the due date forward, which brings an overdue task back to life).
   A submitted task can't be touched — it's a permanent record. */
const update = async (req, res) => {
  try {
    if (!validId(req.params.id))
      return res.status(404).json({ error: "Task not found." });
    const task = await Task.findOne({
      _id: req.params.id,
      createdBy: req.session.userId,
    });
    if (!task) return res.status(404).json({ error: "Task not found." });
    if (isSubmitted(task)) {
      return res
        .status(403)
        .json({
          error: "Submitted tasks are a permanent record and cannot be edited.",
        });
    }

    const { title, description, dueDate } = req.body;
    if (
      (title && typeof title !== "string") ||
      (description && typeof description !== "string")
    ) {
      return res
        .status(400)
        .json({ error: "Title and description must be text." });
    }
    if (title && title.length > 200)
      return res
        .status(400)
        .json({ error: "Title is too long (200 characters max)." });
    if (description && description.length > 5000)
      return res
        .status(400)
        .json({ error: "Description is too long (5000 characters max)." });
    if (dueDate && !validDate(dueDate))
      return res.status(400).json({ error: "Please choose a valid due date." });
    // A past date is refused only when it is a change; saving an overdue task's title with its old date is fine
    if (
      dueDate &&
      isPastDate(dueDate) &&
      new Date(dueDate).getTime() !== new Date(task.dueDate).getTime()
    ) {
      return res
        .status(400)
        .json({ error: "The due date cannot be in the past." });
    }

    const oldDueDate = task.dueDate;
    const updates = {};
    if (title) updates.title = title;
    if (description) updates.description = description;
    if (dueDate) updates.dueDate = dueDate;
    const dueDateChanged =
      dueDate && String(oldDueDate) !== String(new Date(dueDate));
    if (dueDateChanged) {
      updates.remindedDueSoon = false; // a new date, so the reminders can fire again for it
      updates.remindedOverdue = false;
    }
    const supervisor = await User.findById(req.session.userId);
    const internForEmail = dueDateChanged
      ? await User.findById(task.assignedTo)
      : null;
    const updatedTask = await Task.findOneAndUpdate(
      {
        _id: task._id,
        createdBy: req.session.userId,
        "submission.submittedAt": null,
      },
      { $set: updates },
      { returnDocument: "after", runValidators: true },
    );
    if (!updatedTask) {
      return res.status(409).json({
        error: "This task just changed. Reload the page and try again.",
      });
    }

    const detail = dueDateChanged
      ? `Due date moved to ${fmt(updatedTask.dueDate)}`
      : "Title or description edited";
    AuditLog.create({
      action: "edited",
      taskId: task._id,
      taskTitle: updatedTask.title,
      supervisor: updatedTask.createdBy,
      performedBy: req.session.userId,
      performedByName: supervisor?.name || "Unknown",
      details: detail,
    }).catch((err) =>
      console.error("[audit] Failed to log action:", err.message),
    );

    if (dueDateChanged && internForEmail)
      sendDueDateChangedEmail(internForEmail, updatedTask);

    res.json(updatedTask);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update task." });
  }
};

/* DELETE /api/tasks/:id — only an open task (not submitted, not overdue) can
   be deleted, and it's a real, permanent delete: nothing is kept.
   - Submitted tasks are a permanent record and can never be deleted, and neither
     is a task that was sent back for a resubmission (it keeps the earlier attempt).
   - Overdue tasks can't be deleted either — give an extension instead, from
     the Archive page. */
const remove = async (req, res) => {
  try {
    if (!validId(req.params.id))
      return res.status(404).json({ error: "Task not found." });
    const task = await Task.findOne({
      _id: req.params.id,
      createdBy: req.session.userId,
    });
    if (!task) return res.status(404).json({ error: "Task not found." });

    if (isSubmitted(task)) {
      return res
        .status(403)
        .json({
          error:
            "Submitted tasks are a permanent record and cannot be deleted.",
        });
    }
    if (isOverdue(task)) {
      return res
        .status(403)
        .json({
          error:
            "Overdue tasks cannot be deleted. Give the intern an extension instead.",
        });
    }
    if (task.previousSubmissions?.length) {
      return res
        .status(403)
        .json({
          error:
            "This task was submitted before and sent back. The earlier attempt is a permanent record, so the task cannot be deleted.",
        });
    }

    const supervisor = await User.findById(req.session.userId);
    const result = await Task.deleteOne({
      _id: task._id,
      createdBy: req.session.userId,
      "submission.submittedAt": null,
      dueDate: { $gte: localDateKey() },
      $or: [
        { previousSubmissions: { $exists: false } },
        { previousSubmissions: { $size: 0 } },
      ],
    });
    if (!result.deletedCount) {
      const current = await Task.findOne({
        _id: task._id,
        createdBy: req.session.userId,
      });
      if (!current) return res.status(404).json({ error: "Task not found." });
      if (isSubmitted(current)) {
        return res.status(403).json({
          error: "Submitted tasks are a permanent record and cannot be deleted.",
        });
      }
      if (isOverdue(current)) {
        return res.status(403).json({
          error: "Overdue tasks cannot be deleted. Give the intern an extension instead.",
        });
      }
      if (current.previousSubmissions?.length) {
        return res.status(403).json({
          error: "This task was submitted before and sent back. The earlier attempt is a permanent record, so the task cannot be deleted.",
        });
      }
      return res.status(409).json({
        error: "This task just changed. Reload the page and try again.",
      });
    }

    AuditLog.create({
      action: "deleted",
      taskId: task._id,
      taskTitle: task.title,
      supervisor: task.createdBy,
      performedBy: req.session.userId,
      performedByName: supervisor?.name || "Unknown",
    }).catch((err) =>
      console.error("[audit] Failed to log action:", err.message),
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not delete task." });
  }
};

/* POST /api/tasks/:id/feedback — supervisor leaves (or updates) feedback on
   a submitted task. The intern sees it on the task's own page. */
const feedback = async (req, res) => {
  try {
    if (!validId(req.params.id))
      return res.status(404).json({ error: "Task not found." });
    const task = await Task.findOne({
      _id: req.params.id,
      createdBy: req.session.userId,
    });
    if (!task) return res.status(404).json({ error: "Task not found." });
    if (!isSubmitted(task))
      return res
        .status(400)
        .json({ error: "This task has not been submitted yet." });

    const text = String(req.body.text || "").trim();
    if (!text)
      return res.status(400).json({ error: "Feedback cannot be empty." });
    if (text.length > 1000)
      return res
        .status(400)
        .json({ error: "Feedback is too long (1000 characters max)." });

    const [supervisor, intern] = await Promise.all([
      User.findById(req.session.userId),
      User.findById(task.assignedTo),
    ]);
    const feedback = { text, givenAt: new Date() };
    const result = await Task.updateOne(
      {
        _id: task._id,
        createdBy: req.session.userId,
        "submission.submittedAt": task.submission.submittedAt,
        __v: task.__v,
      },
      {
        $set: { "submission.feedback": feedback },
        $inc: { __v: 1 },
      },
    );
    if (!result.modifiedCount) {
      return res.status(409).json({
        error: "This task just changed. Reload the page and try again.",
      });
    }
    task.submission.feedback = feedback;

    if (intern) sendFeedbackGivenEmail(intern, task); // fire-and-forget
    AuditLog.create({
      action: "feedback-given",
      taskId: task._id,
      taskTitle: task.title,
      supervisor: task.createdBy,
      performedBy: req.session.userId,
      performedByName: supervisor?.name || "Unknown",
    }).catch((err) =>
      console.error("[audit] Failed to log action:", err.message),
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save feedback." });
  }
};

/* POST /api/tasks/:id/reopen — the supervisor sends a submitted task back for a
   resubmission. The old submission (file, link, note, feedback) is kept as an
   earlier attempt, the task gets a new due date and goes back to the intern's
   open tasks. A new due date is required, otherwise it would come back already overdue. */
const reopen = async (req, res) => {
  try {
    if (!validId(req.params.id))
      return res.status(404).json({ error: "Task not found." });
    const task = await Task.findOne({
      _id: req.params.id,
      createdBy: req.session.userId,
    });
    if (!task) return res.status(404).json({ error: "Task not found." });
    if (!isSubmitted(task))
      return res
        .status(400)
        .json({
          error:
            "This task has not been submitted, so there is nothing to send back.",
        });

    const reason = String(req.body.reason || "").trim();
    const dueDate = String(req.body.dueDate || "");
    if (!reason)
      return res
        .status(400)
        .json({ error: "Tell the intern what needs to change." });
    if (reason.length > 1000)
      return res
        .status(400)
        .json({ error: "That is too long (1000 characters max)." });
    if (!dueDate || !validDate(dueDate))
      return res.status(400).json({ error: "Choose a new due date." });
    if (isPastDate(dueDate))
      return res
        .status(400)
        .json({ error: "The new due date cannot be in the past." });
    if (task.previousSubmissions.length >= MAX_ATTEMPTS) {
      return res
        .status(400)
        .json({
          error: `This task has already been sent back ${MAX_ATTEMPTS} times.`,
        });
    }

    const intern = await User.findById(task.assignedTo).select(
      "name email active",
    );
    if (!intern || intern.active === false) {
      return res
        .status(400)
        .json({
          error:
            "This intern's internship has ended, so the task cannot be sent back.",
        });
    }

    const earlier = {
      ...task.toObject().submission,
      reopenedAt: new Date(),
      reason,
    };
    const supervisor = await User.findById(req.session.userId);
    // Atomic: only works if the submission is still the one we just read
    const result = await Task.updateOne(
      {
        _id: task._id,
        createdBy: req.session.userId,
        "submission.submittedAt": task.submission.submittedAt,
        __v: task.__v,
      },
      {
        $push: { previousSubmissions: earlier },
        $set: { dueDate, remindedDueSoon: false, remindedOverdue: false },
        $unset: { submission: "" },
        $inc: { __v: 1 },
      },
    );
    if (!result.modifiedCount)
      return res
        .status(409)
        .json({
          error: "This task just changed. Reload the page and try again.",
        });

    task.dueDate = dueDate; // for the email below
    sendResubmissionRequestedEmail(intern, task, reason); // fire-and-forget
    AuditLog.create({
      action: "reopened",
      taskId: task._id,
      taskTitle: task.title,
      supervisor: task.createdBy,
      performedBy: req.session.userId,
      performedByName: supervisor?.name || "Unknown",
      details: `Sent back for resubmission, new due date ${fmt(task.dueDate)}`,
    }).catch((err) =>
      console.error("[audit] Failed to log action:", err.message),
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not send the task back." });
  }
};

module.exports = {
  list,
  archived,
  internsForPicker,
  create,
  extendBatch,
  update,
  remove,
  feedback,
  reopen,
};
