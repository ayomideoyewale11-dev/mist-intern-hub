const mongoose = require("mongoose");
const Task = require("../models/Task");
const User = require("../models/User");
const { localDateKey } = require("../config/dateBoundaries");
const { ringData } = require("../config/progress");
const {
  listParams,
  statusCondition,
  buildPager,
  pastEnd,
} = require("../config/listing");
const { fmt } = require("../config/format");
const { terminatedInternIds, hideTasksOf } = require("../config/terminated");
const { WAITING_SHOWN, PROGRESS_PAGE_SIZE } = require("../config/pageSizes");

/* GET /admin — summary counts and the "assign a task" form; the intern dropdown
   is rendered here with real data, not fetched afterward by the browser.
   The counts are worked out by the database (same rules as the Archive), so
   they stay correct and cheap however many tasks there are. */
const admin = async (req, res) => {
  try {
    const hidden = await terminatedInternIds(req.session.userId); // their tasks are not counted or listed
    const base = { createdBy: req.session.userId, ...hideTasksOf(hidden) };
    const cutoff = localDateKey();
    const waitingFilter = {
      ...base,
      ...statusCondition("submitted"),
      "submission.feedback.text": { $in: [null, ""] },
    };
    const [
      interns,
      perIntern,
      open,
      overdue,
      submitted,
      waitingTotal,
      waiting,
    ] = await Promise.all([
      User.find({
        role: "intern",
        supervisor: req.session.userId,
        active: { $ne: false },
      })
        .select("name email")
        .sort({ name: 1 }),
      // one row per intern: how many tasks are done, open and overdue
      Task.aggregate([
        {
          $match: {
            createdBy: new mongoose.Types.ObjectId(req.session.userId),
          },
        },
        {
          $group: {
            _id: "$assignedTo",
            done: {
              $sum: {
                $cond: [
                  {
                    $ne: [{ $ifNull: ["$submission.submittedAt", null] }, null],
                  },
                  1,
                  0,
                ],
              },
            },
            overdue: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      {
                        $eq: [
                          { $ifNull: ["$submission.submittedAt", null] },
                          null,
                        ],
                      },
                      { $lt: ["$dueDate", cutoff] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            total: { $sum: 1 },
          },
        },
      ]),
      Task.countDocuments({ ...base, ...statusCondition("open") }),
      Task.countDocuments({ ...base, ...statusCondition("overdue") }),
      Task.countDocuments({ ...base, ...statusCondition("submitted") }),
      // submitted work still waiting for the supervisor's feedback: longest-waiting first
      Task.countDocuments(waitingFilter),
      Task.find(waitingFilter)
        .select("title submission.submittedAt assignedTo")
        .populate("assignedTo", "name")
        .sort({ "submission.submittedAt": 1 })
        .limit(WAITING_SHOWN),
    ]);
    const byId = new Map(perIntern.map((r) => [String(r._id), r]));
    const progress = interns
      .map((i) => {
        const r = byId.get(String(i._id)) || { done: 0, overdue: 0, total: 0 };
        return {
          _id: i._id,
          name: i.name,
          ...ringData(r.done, r.overdue, r.total),
        };
      })
      .sort((a, b) => b.overdue - a.overdue || a.name.localeCompare(b.name));
    // the progress card is shown a few interns at a time
    const lp = listParams(req);
    if (pastEnd(res, "/admin", lp, progress.length, PROGRESS_PAGE_SIZE)) return;
    const pg = buildPager("/admin", lp, progress.length, PROGRESS_PAGE_SIZE);
    if (pg.prev) pg.prev += "#progress"; // stay on the progress card after clicking
    if (pg.next) pg.next += "#progress";
    res.render("admin", {
      title: "Supervisor dashboard",
      user: { role: "admin" },
      currentPath: req.path,
      interns,
      progress: progress.slice(
        (lp.page - 1) * PROGRESS_PAGE_SIZE,
        lp.page * PROGRESS_PAGE_SIZE,
      ),
      progressPager: pg,
      waiting: {
        total: waitingTotal,
        items: waiting.map((t) => ({
          _id: t._id,
          title: t.title,
          internName: t.assignedTo ? t.assignedTo.name : "Unknown intern",
          submittedFormatted: fmt(t.submission.submittedAt),
        })),
      },
      stats: { open, overdue, submitted, interns: interns.length },
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

/* GET /intern — the intern's open tasks, queried and rendered here directly.
   No client-side fetch is needed just to show the list any more. */
const intern = async (req, res) => {
  try {
    const tasks = await Task.find({
      assignedTo: req.session.userId,
      "submission.submittedAt": null,
      dueDate: { $gte: localDateKey() },
    }).sort({ dueDate: 1 });

    res.render("intern", {
      title: "My tasks",
      user: { role: "intern" },
      currentPath: req.path,
      tasks: tasks.map((t) => ({
        _id: t._id,
        title: t.title,
        description: t.description,
        dueDateFormatted: fmt(t.dueDate),
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

module.exports = { admin, intern };
