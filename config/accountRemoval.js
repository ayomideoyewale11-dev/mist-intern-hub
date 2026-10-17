const mongoose = require('mongoose');
const User = require('../models/User');
const Task = require('../models/Task');
const AuditLog = require('../models/AuditLog');
const { getBucket } = require('./uploads');

// Permanent removal of accounts, used only by the command-line scripts (scripts/deleteUser.js and
// scripts/handOver.js). The app itself never deletes an account. Nothing here is reversible, so the
// scripts show the counts and ask for confirmation first. The audit log is always kept.

// every stored file (current and earlier attempts) belonging to these tasks
function fileIdsOf(tasks) {
  const ids = [];
  for (const t of tasks) {
    if (t.submission?.file?.fileId) ids.push(t.submission.file.fileId);
    for (const p of t.previousSubmissions || []) if (p.file?.fileId) ids.push(p.file.fileId);
  }
  const seen = new Set();
  return ids.filter((id) => {
    const key = String(id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function deleteGridFSFiles(fileIds) {
  const files = mongoose.connection.db.collection('submissions.files');
  const bucket = getBucket();
  for (const id of fileIds) {
    const exists = await files.findOne({ _id: id }, { projection: { _id: 1 } });
    if (exists) await bucket.delete(id);
  }
}

// ends every login of these users, so nobody stays signed in to a deleted account
async function endSessionsOf(userIds) {
  let removed = 0;
  for (const id of userIds) {
    const r = await mongoose.connection.db.collection('sessions').deleteMany({ session: { $regex: `"userId":"${String(id)}"` } });
    removed += r.deletedCount;
  }
  return removed;
}

// What deleting these interns would remove (no changes made)
async function countForInterns(internIds) {
  const tasks = await Task.find({ assignedTo: { $in: internIds } }).select('submission.file previousSubmissions.file');
  return { interns: internIds.length, tasks: tasks.length, files: fileIdsOf(tasks).length };
}

// Deletes the interns, all their tasks, their uploaded files and their logins.
async function removeInterns(internIds) {
  const tasks = await Task.find({ assignedTo: { $in: internIds } }).select('submission.file previousSubmissions.file');
  const fileIds = fileIdsOf(tasks);
  await deleteGridFSFiles(fileIds);
  const t = await Task.deleteMany({ assignedTo: { $in: internIds } });
  const sessions = await endSessionsOf(internIds);
  const u = await User.deleteMany({ _id: { $in: internIds }, role: 'intern' });
  return { interns: u.deletedCount, tasks: t.deletedCount, files: fileIds.length, sessions };
}

async function removeIntern(intern) {
  return removeInterns([intern._id]);
}

// What deleting a supervisor would remove (no changes made)
async function countForSupervisor(supervisor) {
  const internIds = await User.find({ role: 'intern', supervisor: supervisor._id }).distinct('_id');
  const own = await countForInterns(internIds);
  const strayTasks = await Task.find({ createdBy: supervisor._id, assignedTo: { $nin: internIds } })
    .select('submission.file previousSubmissions.file');
  return {
    ...own,
    tasks: own.tasks + strayTasks.length,
    files: own.files + fileIdsOf(strayTasks).length,
  };
}

// Deletes the supervisor, every intern they own, all of those interns' tasks and files, and the logins.
async function removeSupervisor(supervisor) {
  const internIds = await User.find({ role: 'intern', supervisor: supervisor._id }).distinct('_id');
  const result = await removeInterns(internIds);
  // anything else this supervisor created (should be nothing, but never leave tasks with no owner)
  const stray = await Task.find({ createdBy: supervisor._id }).select('submission.file previousSubmissions.file');
  const strayFileIds = fileIdsOf(stray);
  await deleteGridFSFiles(strayFileIds);
  result.files += strayFileIds.length;
  const t = await Task.deleteMany({ createdBy: supervisor._id });
  result.tasks += t.deletedCount;
  result.sessions += await endSessionsOf([supervisor._id]);
  await User.deleteOne({ _id: supervisor._id, role: 'admin' });
  return { ...result, supervisors: 1 };
}

// Moves everything one supervisor owns to another: the interns, every task, and the audit history.
// The old supervisor's account is left as it is (delete it afterwards if wanted).
async function handOver(fromSupervisor, toSupervisor) {
  if (String(fromSupervisor._id) === String(toSupervisor._id)) throw new Error('Choose two different supervisors.');
  if (fromSupervisor.role !== 'admin' || toSupervisor.role !== 'admin') throw new Error('Both accounts must be supervisors.');
  const interns = await User.updateMany({ role: 'intern', supervisor: fromSupervisor._id }, { $set: { supervisor: toSupervisor._id } });
  const tasks = await Task.updateMany({ createdBy: fromSupervisor._id }, { $set: { createdBy: toSupervisor._id } });
  const logs = await AuditLog.updateMany({ supervisor: fromSupervisor._id }, { $set: { supervisor: toSupervisor._id } });
  return { interns: interns.modifiedCount, tasks: tasks.modifiedCount, logs: logs.modifiedCount };
}

async function countForHandOver(fromSupervisor) {
  return {
    interns: await User.countDocuments({ role: 'intern', supervisor: fromSupervisor._id }),
    tasks: await Task.countDocuments({ createdBy: fromSupervisor._id }),
    logs: await AuditLog.countDocuments({ supervisor: fromSupervisor._id }),
  };
}

module.exports = {
  removeIntern, removeInterns, removeSupervisor, handOver, countForInterns, countForSupervisor, countForHandOver,
};
