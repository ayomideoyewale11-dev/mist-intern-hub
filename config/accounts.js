const { dateHasPassed } = require("./dateBoundaries");

// The end date is the intern's last day, so it has "passed" only after that whole day
const hasEnded = (endDate) => dateHasPassed(endDate);
// What the browser is told about a user (never the password hash or reset token)
const publicUser = (u) => ({ id: u._id, name: u.name, role: u.role });

module.exports = { hasEnded, publicUser };
