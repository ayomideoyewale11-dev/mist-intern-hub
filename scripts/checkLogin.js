// Tells you why a login fails, using the same check the login page uses.
//   node scripts/checkLogin.js person@email.com
// It shows which database it looked in, whether that email has an account there, and (after you type
// the password) whether the password matches. Nothing is changed.
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const User = require("../models/User");
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
    console.error("Usage: node scripts/checkLogin.js person@email.com");
    process.exit(1);
  }
  console.log(`Database: ${whichDatabase()}`);
  await mongoose.connect(process.env.DATABASE);
  const total = await User.countDocuments();
  const user = await User.findOne({ email });
  console.log(`Accounts in this database: ${total}`);
  if (!user) {
    console.log(`RESULT: no account with the email "${email}" in this database.`);
    const others = await User.find({}, "email role").limit(10).lean();
    if (others.length) console.log("Emails that do exist here:", others.map((u) => `${u.email} (${u.role})`).join(", "));
    await mongoose.disconnect();
    return;
  }
  console.log(`Found: ${user.name} <${user.email}>, role ${user.role}, active ${user.active !== false}`);
  const password = await askPassword("Password to test: ");
  const ok = await bcrypt.compare(password, user.passwordHash);
  console.log(ok ? "RESULT: the password MATCHES. Login should work against this database." : "RESULT: the password does NOT match. Run setPassword.js to set a new one.");
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
