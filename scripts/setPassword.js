// Sets a new password for an existing account (e.g. you mistyped it, or forgot it).
//   node scripts/setPassword.js person@email.com
// Asks for the new password twice. Anyone logged in to that account is signed out.
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const User = require("../models/User");
const { validNewPassword } = require("../config/validate");
const askPassword = require("./promptPassword");

function whichDatabase() {
  try {
    const u = new URL(process.env.DATABASE);
    return `${u.host}${u.pathname}`;
  } catch {
    return "(DATABASE is not set or not valid)";
  }
}

(async () => {
  const email = (process.argv[2] || "").toLowerCase().trim();
  if (!email) {
    console.error("Usage: node scripts/setPassword.js person@email.com");
    process.exit(1);
  }
  console.log(`Database: ${whichDatabase()}`);
  await mongoose.connect(process.env.DATABASE);
  const user = await User.findOne({ email });
  if (!user) {
    console.error("No account with that email.");
    process.exit(1);
  }
  const password = await askPassword("New password: ");
  if (!validNewPassword(password)) {
    console.error("Password must be at least 8 characters and no more than 72 UTF-8 bytes.");
    process.exit(1);
  }
  const again = await askPassword("Type it again: ");
  if (again !== password) {
    console.error("The two passwords are different. Nothing was changed. Run the command again.");
    process.exit(1);
  }
  user.passwordHash = await bcrypt.hash(password, 10);
  user.resetTokenHash = undefined;
  user.resetTokenExpires = undefined;
  await user.save();
  await mongoose.connection.db.collection("sessions").deleteMany({ session: { $regex: `"userId":"${String(user._id)}"` } });
  console.log(`Password changed for ${user.name} <${user.email}>.`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
