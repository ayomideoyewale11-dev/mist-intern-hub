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
    const filters = auditFilters(req);
    const filter = filters.filter;
    const params = filters.params;

    const [entries, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * AUDIT_PAGE_SIZE)
        .limit(AUDIT_PAGE_SIZE),
      AuditLog.countDocuments(filter),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
    if (page > totalPages) {
      params.set("page", String(totalPages));
      return res.redirect(`/audit-log?${params.toString()}`);
    }

    res.render("auditLog", {
      title: "Audit log",
      user: { role: "admin" },
      currentPath: req.path,
      page,
      totalPages,
      total,
      q: filters.q,
      action: filters.action,
      from: filters.from,
      to: filters.to,
      actions: AuditLog.schema.path("action").enumValues,
      exportHref: `/audit-log/export.csv${params.toString() ? `?${params.toString()}` : ""}`,
      clearHref: "/audit-log",
      pageHref: (p) => {
        const pageParams = new URLSearchParams(params);
        if (p > 1) pageParams.set("page", String(p));
        else pageParams.delete("page");
        return `/audit-log${pageParams.toString() ? `?${pageParams.toString()}` : ""}`;
      },
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

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function auditFilters(req) {
  const q = String(req.query.q || "").trim().slice(0, 100);
  const allowedActions = AuditLog.schema.path("action").enumValues;
  const action = allowedActions.includes(req.query.action) ? req.query.action : "";
  const from = validDate(req.query.from) ? req.query.from : "";
  const to = validDate(req.query.to) ? req.query.to : "";
  const filter = { supervisor: req.session.userId };
  const conditions = [];
  if (q) {
    const re = new RegExp(escapeRegex(q), "i");
    conditions.push({ $or: [{ internName: re }, { taskTitle: re }] });
  }
  if (action) filter.action = action;
  if (from || to) {
    const createdAt = {};
    if (from) createdAt.$gte = new Date(`${from}T00:00:00.000Z`);
    if (to) {
      const end = new Date(`${to}T00:00:00.000Z`);
      end.setUTCDate(end.getUTCDate() + 1);
      createdAt.$lt = end;
    }
    filter.createdAt = createdAt;
  }
  if (conditions.length) filter.$and = conditions;
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (action) params.set("action", action);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return { filter, params, q, action, from, to };
}

function csvCell(value) {
  let text = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/* GET /audit-log/export.csv — exports every row matching the current filters. */
const exportAuditLog = async (req, res) => {
  try {
    const { filter } = auditFilters(req);
    const entries = await AuditLog.find(filter).sort({ createdAt: -1 });
    const rows = [
      ["Date and time", "Subject", "Action", "Details", "Done by"],
      ...entries.map((e) => [
        new Date(e.createdAt).toLocaleString("en-GB"),
        e.taskTitle || e.internName || "Unknown",
        e.action.replace(/-/g, " "),
        e.details || "",
        e.performedByName,
      ]),
    ];
    const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", 'attachment; filename="audit-logs.csv"');
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).send("Something went wrong.");
  }
};

module.exports = { archive, exportPdf, auditLog, exportAuditLog };
