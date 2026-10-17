/* GET /api/suggest — a few quick matches shown under a search box while the
   person is still typing. Read-only, scoped to the logged-in person:
   a supervisor only ever gets their own interns and tasks, an intern only
   their own tasks.
     ?kind=archive   tasks and interns            (supervisor)
     ?kind=interns   current interns              (supervisor)
     ?kind=alumni    interns whose internship ended (supervisor)
     ?kind=history   one intern's tasks           (supervisor with &internId=, or the intern themself) */
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const Task = require("../models/Task");
const User = require("../models/User");
const { requireLogin } = require("../middleware/authGuards");
const { taskStatus } = require("../config/taskStatus");
const { fmt } = require("../config/format");
const { escapeRegex } = require("../config/listing");
const { terminatedInternIds, hideTasksOf } = require("../config/terminated");

const LIMIT = 5;
const STATUS_TEXT = {
  open: "Open",
  overdue: "Overdue",
  submitted: "Submitted",
};

router.get("/", requireLogin, async (req, res, next) => {
  try {
    const q = String(req.query.q || "")
      .trim()
      .slice(0, 100);
    const kind = String(req.query.kind || "");
    if (q.length < 2) return res.json({ items: [] });
    const re = new RegExp(escapeRegex(q), "i");
    const isAdmin = req.session.role === "admin";
    const me = req.session.userId;
    const items = [];

    const internItem = (u, from) => ({
      label: u.name,
      sub: u.email,
      url: `/interns/${u._id}${from ? "?back=%2Farchive" : ""}`,
    });
    const taskItem = (t, who, urlSuffix = "") => ({
      label: t.title,
      sub: `${who ? `${who} · ` : ""}${STATUS_TEXT[taskStatus(t)]} · due ${fmt(t.dueDate)}`,
      url: `/tasks/${t._id}${urlSuffix}`,
    });

    if (isAdmin && kind === "archive") {
      const hidden = await terminatedInternIds(me); // terminated interns and their tasks are not suggested
      const [interns, tasks] = await Promise.all([
        User.find({
          role: "intern",
          supervisor: me,
          terminatedAt: null,
          $or: [{ name: re }, { email: re }],
        })
          .select("name email")
          .sort({ name: 1 })
          .limit(LIMIT),
        Task.find({ createdBy: me, ...hideTasksOf(hidden), title: re })
          .select("title dueDate submission.submittedAt assignedTo")
          .populate("assignedTo", "name")
          .sort({ createdAt: -1 })
          .limit(LIMIT),
      ]);
      interns.forEach((u) => items.push(internItem(u, true)));
      tasks.forEach((t) =>
        items.push(taskItem(t, t.assignedTo && t.assignedTo.name)),
      );
    } else if (isAdmin && (kind === "interns" || kind === "alumni")) {
      const active = kind === "interns" ? { $ne: false } : false;
      const users = await User.find({
        role: "intern",
        supervisor: me,
        active,
        $or: [{ name: re }, { email: re }],
      })
        .select("name email")
        .sort({ name: 1 })
        .limit(LIMIT + 3);
      users.forEach((u) => items.push(internItem(u, false)));
    } else if (kind === "history") {
      let internId = me;
      if (isAdmin) {
        internId = String(req.query.internId || "");
        if (
          !mongoose.isValidObjectId(internId) ||
          !(await User.exists({
            _id: internId,
            role: "intern",
            supervisor: me,
          }))
        )
          return res.json({ items: [] });
      }
      const tasks = await Task.find({ assignedTo: internId, title: re })
        .select("title dueDate submission.submittedAt")
        .sort({ createdAt: -1 })
        .limit(LIMIT + 3);
      tasks.forEach((t) =>
        items.push(taskItem(t, "", isAdmin ? "" : "?from=history")),
      );
    } else {
      return res.status(400).json({ error: "Unknown search." });
    }
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
