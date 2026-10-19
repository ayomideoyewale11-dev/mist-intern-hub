const mongoose = require("mongoose");
const Task = require("../models/Task");
const User = require("../models/User");
const { taskStatus } = require("../config/taskStatus");
const { streamReportPdf } = require("../config/exports");
const {
  escapeRegex,
  backTarget,
  listParams,
  statusCondition,
  buildPager,
  pastEnd,
} = require("../config/listing");
const { fmt } = require("../config/format");
const { LIST_PAGE_SIZE, HISTORY_PAGE_SIZE } = require("../config/pageSizes");

/* GET /interns — the supervisor's current interns, with links to register a
   new one, view an intern's task history, or edit their details. Ended
   internships are on /alumni instead. */
const list = async (req, res) => {
  try {
    const lp = listParams(req);
    const base = {
      role: "intern",
      supervisor: req.session.userId,
      active: { $ne: false },
    };
    const filter = { ...base };
    if (lp.q) {
      const re = new RegExp(escapeRegex(lp.q), "i");
      filter.$or = [{ name: re }, { email: re }];
    }
    const [list, total, everything] = await Promise.all([
      User.find(filter)
        .select("name email internshipStartDate internshipEndDate")
        .sort({ name: 1 })
        .skip((lp.page - 1) * LIST_PAGE_SIZE)
        .limit(LIST_PAGE_SIZE),
      User.countDocuments(filter),
      User.countDocuments(base),
    ]);
    if (pastEnd(res, "/interns", lp, total, LIST_PAGE_SIZE)) return;
    res.render("interns", {
      title: "Interns",
      user: { role: "admin" },
      currentPath: req.path,
      q: lp.q,
      total,
      everything,
      pg: buildPager("/interns", lp, total, LIST_PAGE_SIZE),
      interns: list.map((i) => ({
        _id: i._id,
        name: i.name,
        email: i.email,
        startFormatted: i.internshipStartDate
          ? fmt(i.internshipStartDate)
          : "—",
        endFormatted: i.internshipEndDate ? fmt(i.internshipEndDate) : "—",
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

/* GET /interns/new — the "register a new intern" form, its own page.
   Registered BEFORE /interns/:id below, or Express would try to match
   "new" as an intern's id and 404 instead of showing this form. */
const newForm = (req, res) => {
  res.render("registerIntern", {
    title: "Register a new intern",
    user: { role: "admin" },
    currentPath: req.path,
  });
};

/* GET /interns/:id/edit — change an intern's details, end or restore their
   internship, or resend the welcome email. Reached from the Interns page. */
const edit = async (req, res) => {
  try {
    const notFound = () =>
      res
        .status(404)
        .render("error", {
          title: "Not found",
          message: "This intern doesn't exist, or isn't one of your interns.",
        });
    if (!mongoose.isValidObjectId(req.params.id)) return notFound();
    const intern = await User.findOne({
      _id: req.params.id,
      role: "intern",
      supervisor: req.session.userId,
    });
    if (!intern) return notFound();
    res.render("editIntern", {
      backTo: backTarget(req.query.back, "/interns", "Interns"),
      title: `Edit ${intern.name}`,
      user: { role: "admin" },
      currentPath: req.path,
      intern: {
        _id: intern._id,
        name: intern.name,
        email: intern.email,
        active: intern.active !== false,
        terminated: Boolean(intern.terminatedAt),
        terminatedFormatted: intern.terminatedAt
          ? fmt(intern.terminatedAt)
          : null,
        terminationReason: intern.terminationReason || "",
        startDateInput: intern.internshipStartDate
          ? new Date(intern.internshipStartDate).toISOString().slice(0, 10)
          : "",
        endDateInput: intern.internshipEndDate
          ? new Date(intern.internshipEndDate).toISOString().slice(0, 10)
          : "",
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

/* GET /interns/:id — one intern's full task history, for review or reference */
const history = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res
        .status(404)
        .render("error", {
          title: "Not found",
          message: "This intern doesn't exist, or isn't one of your interns.",
        });
    }
    const intern = await User.findOne({
      _id: req.params.id,
      role: "intern",
      supervisor: req.session.userId,
    });
    if (!intern) {
      return res
        .status(404)
        .render("error", {
          title: "Not found",
          message: "This intern doesn't exist, or isn't one of your interns.",
        });
    }

    const lp = listParams(req);
    const filter = { assignedTo: intern._id };
    if (lp.q) filter.title = new RegExp(escapeRegex(lp.q), "i");
    const sc = statusCondition(lp.status);
    if (sc) Object.assign(filter, sc);
    const [tasks, total, everything] = await Promise.all([
      Task.find(filter)
        .select("title dueDate submission.submittedAt")
        .sort({ createdAt: -1 })
        .skip((lp.page - 1) * HISTORY_PAGE_SIZE)
        .limit(HISTORY_PAGE_SIZE),
      Task.countDocuments(filter),
      Task.countDocuments({ assignedTo: intern._id }),
    ]);

    if (pastEnd(res, `/interns/${intern._id}`, lp, total, HISTORY_PAGE_SIZE))
      return;

    res.render("internHistory", {
      q: lp.q,
      status: lp.status,
      everything,
      back: lp.back,
      backTo: backTarget(
        lp.back,
        intern.active !== false ? "/interns" : "/alumni",
        intern.active !== false ? "Interns" : "Alumni",
      ),
      pg: buildPager(`/interns/${intern._id}`, lp, total, HISTORY_PAGE_SIZE),
      title: intern.name,
      user: { role: "admin" },
      currentPath: req.path,
      intern: {
        _id: intern._id,
        name: intern.name,
        email: intern.email,
        active: intern.active,
        terminated: Boolean(intern.terminatedAt),
        terminatedFormatted: intern.terminatedAt
          ? fmt(intern.terminatedAt)
          : null,
        terminationReason: intern.terminationReason || "",
        startFormatted: intern.internshipStartDate
          ? fmt(intern.internshipStartDate)
          : null,
        endFormatted: intern.internshipEndDate
          ? fmt(intern.internshipEndDate)
          : null,
      },
      tasks: tasks.map((t) => {
        const status = taskStatus(t);
        return {
          _id: t._id,
          title: t.title,
          dueDateFormatted: fmt(t.dueDate),
          status,
        };
      }),
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

/* GET /interns/:id/export.pdf — one intern's task history as a downloadable PDF */
const exportPdf = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(404).send("Not found.");
    const intern = await User.findOne({
      _id: req.params.id,
      role: "intern",
      supervisor: req.session.userId,
    });
    if (!intern) return res.status(404).send("Not found.");

    const tasks = await Task.find({ assignedTo: intern._id }).sort({
      createdAt: -1,
    });
    streamReportPdf(res, {
      filename: `${intern.name.replace(/\W+/g, "-")}-tasks.pdf`,
      title: "Task history",
      subtitle: `${intern.name}`,
      groups: [
        {
          name: intern.name,
          email: intern.email,
          tasks: [...tasks].sort(
            (x, y) => new Date(x.dueDate) - new Date(y.dueDate),
          ),
        },
      ],
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Something went wrong.");
  }
};

/* GET /alumni — interns whose internship has ended. Their account and full
   task history are untouched; they're just no longer offered in the "assign
   a task" dropdown. See config/scheduler.js for how they end up here. */
const alumni = async (req, res) => {
  try {
    const lp = listParams(req);
    const base = {
      role: "intern",
      supervisor: req.session.userId,
      active: false,
    };
    const filter = { ...base };
    if (lp.q) {
      const re = new RegExp(escapeRegex(lp.q), "i");
      filter.$or = [{ name: re }, { email: re }];
    }
    const pipeline = [
      {
        $match: {
          ...filter,
          supervisor: new mongoose.Types.ObjectId(req.session.userId),
        },
      },
      { $addFields: { leftDate: { $ifNull: ["$terminatedAt", "$internshipEndDate"] } } },
    ];
    if (lp.leftIn) {
      const [year, month] = lp.leftIn.split("-").map(Number);
      pipeline.push({
        $match: {
          leftDate: {
            $gte: new Date(Date.UTC(year, month - 1, 1)),
            $lt: new Date(Date.UTC(year, month, 1)),
          },
        },
      });
    }
    const [result, everything] = await Promise.all([
      User.aggregate([
        ...pipeline,
        { $sort: { leftDate: -1, name: 1 } },
        {
          $facet: {
            rows: [
              { $skip: (lp.page - 1) * LIST_PAGE_SIZE },
              { $limit: LIST_PAGE_SIZE },
            ],
            total: [{ $count: "n" }],
          },
        },
      ]),
      User.countDocuments(base),
    ]);
    const alumni = result[0].rows;
    const total = result[0].total[0]?.n || 0;

    if (pastEnd(res, "/alumni", lp, total, LIST_PAGE_SIZE)) return;

    res.render("alumni", {
      title: "Alumni",
      user: { role: "admin" },
      currentPath: req.path,
      q: lp.q,
      leftIn: lp.leftIn,
      total,
      everything,
      pg: buildPager("/alumni", lp, total, LIST_PAGE_SIZE),
      alumni: alumni.map((a) => ({
        _id: a._id,
        name: a.name,
        email: a.email,
        terminated: Boolean(a.terminatedAt),
        startFormatted: a.internshipStartDate
          ? fmt(a.internshipStartDate)
          : "—",
        endFormatted: a.leftDate ? fmt(a.leftDate) : "—",
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

module.exports = { list, newForm, edit, history, exportPdf, alumni };
