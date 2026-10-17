// Make sure ended internships are deactivated before a supervisor list renders
async function sweepEnded(req, res, next) {
  try {
    await require("../config/scheduler").deactivateEndedInternships();
  } catch (e) {
    console.error(e.message);
  }
  next();
}

module.exports = sweepEnded;
