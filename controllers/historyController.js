const User = require('../models/User');
const Task = require('../models/Task');
const { taskStatus } = require('../config/taskStatus');
const { streamReportPdf } = require('../config/exports');
const { ringData } = require('../config/progress');
const { escapeRegex, listParams, statusCondition, buildPager, pastEnd } = require('../config/listing');
const { fmt } = require('../config/format');
const { HISTORY_PAGE_SIZE } = require('../config/pageSizes');

/* GET /my-history/export.pdf — the intern's own record (every task, what they
   handed in, and the feedback they got) as a PDF, e.g. for a reference letter or
   a school report. Only ever their own tasks. */
const exportPdf = async (req, res) => {
  try {
    const me = await User.findById(req.session.userId).select('name email internshipStartDate internshipEndDate');
    if (!me) return res.status(404).send('Not found.');

    const tasks = await Task.find({ assignedTo: me._id })
      .select('-submission.file.fileId -previousSubmissions')
      .sort({ dueDate: 1 });
    const period = me.internshipStartDate && me.internshipEndDate
      ? `Internship ${fmt(me.internshipStartDate)} to ${fmt(me.internshipEndDate)}` : '';
    streamReportPdf(res, {
      filename: `${(me.name || 'intern').replace(/\W+/g, '-')}-my-record.pdf`,
      title: 'My task record',
      subtitle: [me.name, period].filter(Boolean).join('   |   '),
      groups: [{ name: me.name, email: me.email, tasks }],
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Something went wrong.');
  }
};

/* GET /my-history — an intern's own full task history (every status, not
   just open ones), so they can find old feedback or submissions without
   needing to still have the original assignment email. */
const myHistory = async (req, res) => {
  try {
    const lp = listParams(req);
    const filter = { assignedTo: req.session.userId };
    if (lp.q) filter.title = new RegExp(escapeRegex(lp.q), 'i');
    const sc = statusCondition(lp.status);
    if (sc) Object.assign(filter, sc);

    // the progress ring always covers ALL of this intern's tasks, whatever the search or filter
    const mine = { assignedTo: req.session.userId };
    const [tasks, total, everything, doneCount, overdueCount] = await Promise.all([
      Task.find(filter).select('title dueDate submission.submittedAt').sort({ createdAt: -1 })
        .skip((lp.page - 1) * HISTORY_PAGE_SIZE).limit(HISTORY_PAGE_SIZE),
      Task.countDocuments(filter),
      Task.countDocuments(mine),
      Task.countDocuments({ ...mine, ...statusCondition('submitted') }),
      Task.countDocuments({ ...mine, ...statusCondition('overdue') }),
    ]);

    if (pastEnd(res, '/my-history', lp, total, HISTORY_PAGE_SIZE)) return;

    res.render('myHistory', {
      title: 'My history',
      user: { role: 'intern' },
      currentPath: req.path,
      q: lp.q, status: lp.status, everything,
      ring: ringData(doneCount, overdueCount, everything),
      pg: buildPager('/my-history', lp, total, HISTORY_PAGE_SIZE),
      tasks: tasks.map((t) => ({
        _id: t._id, title: t.title, dueDateFormatted: fmt(t.dueDate), status: taskStatus(t),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Something went wrong', message: 'Please try again in a moment.' });
  }
};

module.exports = { exportPdf, myHistory };
