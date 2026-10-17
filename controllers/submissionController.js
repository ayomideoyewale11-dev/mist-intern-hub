const path = require('path');
const Task = require('../models/Task');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { getBucket } = require('../config/uploads');
const { saveToGridFS, getFileTypeFromBuffer, MIME_BY_EXT, isPlainTextBuffer, isLegacyOfficeBuffer } = require('../middleware/upload');
const { isOverdue, isSubmitted } = require('../config/taskStatus');
const { localDateKey } = require('../config/dateBoundaries');
const { validId, isHttpUrl } = require('../config/validate');
const { sendTaskSubmittedEmail } = require('../config/mailer');

/* POST /api/tasks/:id/submission — the assigned intern submits their work
   (once only). This is what moves a task off the intern's page for good. */
const submit = async (req, res) => {
  const uploaded = req.file;
  const fail = (code, msg) => res.status(code).json({ error: msg });
  let uploadedFileId;
  const discardFile = async () => {
    if (!uploadedFileId) return;
    const fileId = uploadedFileId;
    uploadedFileId = undefined;
    try {
      await getBucket().delete(fileId);
    } catch (err) {
      console.error('[upload] Could not remove an unlinked submission file:', err.message);
    }
  };

  try {
    if (!validId(req.params.id)) return fail(404, 'Task not found.');
    const task = await Task.findOne({ _id: req.params.id, assignedTo: req.session.userId });
    if (!task) return fail(404, 'Task not found.');

    if (isSubmitted(task)) return fail(409, 'You have already submitted this task.');
    if (isOverdue(task)) {
      return fail(403, 'The deadline for this task has passed. Please contact your supervisor.');
    }

    const link = String(req.body.link || '').trim(); // String() in case a form field is sent twice
    const note = String(req.body.note || '').trim();
    if (link && (link.length > 500 || !isHttpUrl(link))) {
      return fail(400, 'Link must be a valid http:// or https:// address.');
    }
    if (note.length > 1000) return fail(400, 'Note is too long (1000 characters max).');
    if (!uploaded && !link) return fail(400, 'Attach a file or add a link.');

    // Check the file's real content, not just its name — a renamed .exe saved
    // as "report.pdf" still passes the extension check in handleUpload above,
    // but its actual file signature won't match anything on this list.
    if (uploaded) {
      const ext = path.extname(uploaded.originalname).toLowerCase();
      const NO_RELIABLE_SIGNATURE = ['.txt', '.csv']; // plain text has no magic number to check
      if (NO_RELIABLE_SIGNATURE.includes(ext)) {
        if (!isPlainTextBuffer(uploaded.buffer)) {
          return fail(400, `That file doesn't look like a real ${ext.slice(1).toUpperCase()} file.`);
        }
      } else {
        const fileTypeFromBuffer = await getFileTypeFromBuffer();
        const detected = await fileTypeFromBuffer(uploaded.buffer);
        const legacyOfficeContainer = detected?.mime === 'application/x-cfb' && isLegacyOfficeBuffer(uploaded.buffer, ext);
        if (!detected || (!(MIME_BY_EXT[ext] || []).includes(detected.mime) && !legacyOfficeContainer)) {
          return fail(400, `That file doesn't look like a real ${ext.slice(1).toUpperCase()} file.`);
        }
      }
    }

    const submission = { link, note, submittedAt: new Date() };
    if (uploaded) {
      uploadedFileId = await saveToGridFS(uploaded.buffer, uploaded.originalname);
      submission.file = { originalName: uploaded.originalname, fileId: uploadedFileId, size: uploaded.size };
    }

    // Atomic: only succeeds if nothing has been submitted yet (blocks double-clicks / two tabs)
    const result = await Task.updateOne(
      {
        _id: task._id,
        'submission.submittedAt': null,
        dueDate: { $gte: localDateKey() },
      },
      { $set: { submission } });
    if (!result.modifiedCount) {
      await discardFile(); // lost the race — don't leave an orphaned file in GridFS
      const current = await Task.findById(task._id).select('submission.submittedAt dueDate');
      if (!current) return fail(404, 'Task not found.');
      if (isSubmitted(current)) return fail(409, 'You have already submitted this task.');
      if (isOverdue(current)) {
        return fail(403, 'The deadline for this task has passed. Please contact your supervisor.');
      }
      return fail(409, 'This task just changed. Reload the page and try again.');
    }

    // Notify the supervisor who created it, and log the submission — fire-and-forget
    Promise.all([User.findById(req.session.userId), User.findById(task.createdBy)])
      .then(([intern, supervisor]) => {
        if (intern && supervisor) sendTaskSubmittedEmail(supervisor, intern, task);
        AuditLog.create({
          action: 'submitted', taskId: task._id, taskTitle: task.title, supervisor: task.createdBy,
          performedBy: req.session.userId, performedByName: intern?.name || 'Unknown',
        }).catch((err) => console.error('[audit] Failed to log action:', err.message));
      })
      .catch((err) => console.error('[mailer] Could not load users for notification:', err.message));

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    await discardFile();
    fail(500, 'Could not save submission.');
  }
};

// Sends one stored file as a download. Non-ASCII filenames (e.g. Chinese or
// Yoruba characters) make a plain header value throw, so send an ASCII
// fallback plus the RFC 5987 form.
function sendStoredFile(res, file) {
  const rawName = file.originalName || 'submission';
  const asciiName = rawName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  res.set('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(rawName)}`);
  getBucket().openDownloadStream(file.fileId)
    .on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'File not found.' }); })
    .pipe(res);
}

// The assigned intern or that intern's supervisor, nobody else
const canSeeTask = (req, task) => task && (
  (req.session.role === 'intern' && String(task.assignedTo) === req.session.userId) ||
  (req.session.role === 'admin' && String(task.createdBy) === req.session.userId));

/* GET /api/tasks/:id/submission/file — download the file (assigned intern or the intern's supervisor) */
const downloadSubmission = async (req, res) => {
  try {
    if (!validId(req.params.id)) return res.status(404).json({ error: 'File not found.' });
    const task = await Task.findById(req.params.id);
    const file = task?.submission?.file;
    if (!canSeeTask(req, task) || !file?.fileId) return res.status(404).json({ error: 'File not found.' });
    sendStoredFile(res, file);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not download file.' });
  }
};

/* GET /api/tasks/:id/earlier/:n/file — the file from an earlier attempt (n counts from 0) */
const downloadEarlier = async (req, res) => {
  try {
    if (!validId(req.params.id) || !/^\d{1,3}$/.test(req.params.n)) return res.status(404).json({ error: 'File not found.' });
    const task = await Task.findById(req.params.id);
    const file = task?.previousSubmissions?.[Number(req.params.n)]?.file;
    if (!canSeeTask(req, task) || !file?.fileId) return res.status(404).json({ error: 'File not found.' });
    sendStoredFile(res, file);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not download file.' });
  }
};

module.exports = { submit, downloadSubmission, downloadEarlier };
