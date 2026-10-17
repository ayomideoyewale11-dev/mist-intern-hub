const mongoose = require("mongoose");
const Task = require("../models/Task");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { taskStatus } = require("../config/taskStatus");
const { streamReportPdf, sortTasks } = require("../config/exports");
const {
  escapeRegex,
  listParams,
  statusCondition,
  buildPager,
  pastEnd,
  parsePage,
} = require("../config/listing");
const { fmt } = require("../config/format");
const { terminatedInternIds, hideTasksOf } = require("../config/terminated");
const {
  ARCHIVE_PAGE_SIZE,
  ARCHIVE_TASKS_PER_INTERN,
  AUDIT_PAGE_SIZE,
} = require("../config/pageSizes");

/* GET /archive — every task ever assigned, grouped by intern, with a summary
   count at the top. The page shows 25 interns at a time (however many tasks
   each has), and inside each intern's dropdown only their newest 25 tasks, with
   a link to their full (paged) history. The summary counts always cover ALL of
   this supervisor's tasks. */
const archive = async (req, res) => {
  try {
    const lp = listParams(req);
    const hidden = await terminatedInternIds(req.session.userId); // their tasks stay out of the Archive
    const base = { createdBy: req.session.userId, ...hideTasksOf(hidden) };
    const filter = { ...base };
    if (lp.q) {
      const re = new RegExp(escapeRegex(lp.q), "i");
      const ids = await User.find({
        role: "intern",
        supervisor: req.session.userId,
        name: re,
      }).distinct("_id");
      filter.$or = [{ title: re }, { assignedTo: { $in: ids } }];
    }
    const sc = statusCondition(lp.status);
    if (sc) Object.assign(filter, sc);

    // Page by INTERN (25 per page), however many tasks each one has.
    const matchFilter = {
      ...filter,
      createdBy: new mongoose.Types.ObjectId(req.session.userId),
    };
    const [paged, open, overdue, submitted] = await Promise.all([
      Task.aggregate([
        { $match: matchFilter },
        { $group: { _id: "$assignedTo", count: { $sum: 1 } } },
        {
          $lookup: {
            from: User.collection.name,
            localField: "_id",
            foreignField: "_id",
            as: "u",
          },
        },
        {
          $addFields: {
            name: {
              $ifNull: [{ $arrayElemAt: ["$u.name", 0] }, "Unknown intern"],
            },
            known: { $gt: [{ $size: "$u" }, 0] },
          },
        },
        { $addFields: { lname: { $toLower: "$name" } } },
        { $sort: { lname: 1, _id: 1 } },
        {
          $facet: {
            rows: [
              { $skip: (lp.page - 1) * ARCHIVE_PAGE_SIZE },
              { $limit: ARCHIVE_PAGE_SIZE },
            ],
            total: [{ $count: "n" }],
          },
        },
      ]),
      Task.countDocuments({ ...base, ...statusCondition("open") }),
      Task.countDocuments({ ...base, ...statusCondition("overdue") }),
      Task.countDocuments({ ...base, ...statusCondition("submitted") }),
    ]);
    const internRows = paged[0].rows;
    const totalInterns = paged[0].total[0] ? paged[0].total[0].n : 0;
    if (pastEnd(res, "/archive", lp, totalInterns, ARCHIVE_PAGE_SIZE)) return;
    const stats = { open, overdue, submitted }; // always the full totals, whatever is searched

    // The newest ARCHIVE_TASKS_PER_INTERN tasks for each intern on this page
    const groups = await Promise.all(
      internRows.map(async (row) => {
        const tasks = await Task.find({
          $and: [filter, { assignedTo: row._id }],
        })
          .select("-submission.file.fileId -previousSubmissions")
          .sort({ createdAt: -1 })
          .limit(ARCHIVE_TASKS_PER_INTERN);
        return {
          id: String(row._id),
          name: row.name,
          known: row.known,
          count: row.count,
          tasks: tasks.map((t) => ({
            _id: t._id,
            title: t.title,
            dueDateFormatted: fmt(t.dueDate),
            status: taskStatus(t),
            hasFeedback: Boolean(
              t.submission &&
              t.submission.feedback &&
              t.submission.feedback.text,
            ),
          })),
        };
      }),
    );

    res.render("archive", {
      title: "Archive",
      user: { role: "admin" },
      currentPath: req.path,
      q: lp.q,
      status: lp.status,
      pg: buildPager("/archive", lp, totalInterns, ARCHIVE_PAGE_SIZE),
      stats,
      groups,
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

/* GET /archive/export.pdf — every one of this supervisor's tasks as a downloadable PDF */
const exportPdf = async (req, res) => {
  try {
    const hidden = await terminatedInternIds(req.session.userId);
    const tasks = await Task.find({
      createdBy: req.session.userId,
      ...hideTasksOf(hidden),
    })
      .select("-submission.file.fileId -previousSubmissions")
      .populate("assignedTo", "name email")
      .sort({ createdAt: -1 });

    const me = await User.findById(req.session.userId).select("name");
    const byIntern = new Map();
    sortTasks(tasks).forEach((t) => {
      const key = String(t.assignedTo?._id || "unknown");
      if (!byIntern.has(key))
        byIntern.set(key, {
          name: t.assignedTo?.name,
          email: t.assignedTo?.email,
          tasks: [],
        });
      byIntern.get(key).tasks.push(t);
    });
    streamReportPdf(res, {
      filename: "tasks.pdf",
      title: "Task report",
      subtitle: `Supervisor: ${me?.name || "Unknown"}`,
      groups: [...byIntern.values()],
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Something went wrong.");
  }
};

/* GET /audit-log — a plain, read-only record of who did what and when.
   Covers both task actions and account actions (registering/editing/
   (de)activating an intern, resending a welcome email, changing a password). */
const auditLog = async (req, res) => {
  try {
    const page = parsePage(req.query.page);
    const filter = { supervisor: req.session.userId };

    const [entries, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * AUDIT_PAGE_SIZE)
        .limit(AUDIT_PAGE_SIZE),
      AuditLog.countDocuments(filter),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
    if (page > totalPages) return res.redirect(`/audit-log?page=${totalPages}`);

    res.render("auditLog", {
      title: "Audit log",
      user: { role: "admin" },
      currentPath: req.path,
      page,
      totalPages,
      total,
      entries: entries.map((e) => ({
        action: e.action,
        taskId: e.taskId,
        taskTitle: e.taskTitle,
        internId: e.internId,
        internName: e.internName,
        performedByName: e.performedByName,
        details: e.details,
        whenFormatted: new Date(e.createdAt).toLocaleString("en-GB"),
      })),
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

module.exports = { archive, exportPdf, auditLog };
