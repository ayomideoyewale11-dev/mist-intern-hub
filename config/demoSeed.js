function getDemoDatabaseUri(env = process.env) {
  return env.DATABASE_LOCAL;
}

function demoTaskCleanupFilter(supervisorId, demoInternIds) {
  return {
    $or: [
      { assignedTo: { $in: demoInternIds }, createdBy: supervisorId },
      { createdBy: supervisorId, demoSeeded: true },
    ],
  };
}

function legacyDemoTaskCleanupFilter(supervisorId, demoInternIds) {
  return {
    createdBy: supervisorId,
    assignedTo: { $nin: demoInternIds },
    demoSeeded: { $ne: true },
    title: /^\[Demo\] Task \d+$/,
    description: "Demo task.",
  };
}

module.exports = {
  getDemoDatabaseUri,
  demoTaskCleanupFilter,
  legacyDemoTaskCleanupFilter,
};
