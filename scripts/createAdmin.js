// Usage: node scripts/createAdmin.js "Name" email@example.com
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const User = require("../models/User");
const { validEmail, validNewPassword } = require("../config/validate");
const askPassword = require("./promptPassword");

// Which database this will write to (host and name only, never the password), so a mix-up between
// the local and the live database is visible before anything is created.
function whichDatabase() {
  try {
    const u = new URL(process.env.DATABASE);
    return `${u.host}${u.pathname}`;
  } catch {
    return "(DATABASE is not set or not valid)";
  }
}

(async () => {
  const [name, email] = process.argv.slice(2);
  if (!name || !email) {
    console.error('Usage: node scripts/createAdmin.js "Name" email');
    process.exit(1);
  }
  if (!validEmail(email)) {
    console.error("Please provide a valid email address.");
    process.exit(1);
  }
  console.log(`Database: ${whichDatabase()}`);
  const password = await askPassword("Password: ");
  if (!validNewPassword(password)) {
    console.error("Password must be at least 8 characters and no more than 72 UTF-8 bytes.");
    process.exit(1);
  }
  const again = await askPassword("Type it again: ");
  if (again !== password) {
    console.error("The two passwords are different. Nothing was created. Run the command again.");
    process.exit(1);
  }
  await mongoose.connect(process.env.DATABASE);
  await User.create({
    name,
    email,
    passwordHash: await bcrypt.hash(password, 10),
    role: "admin",
  });
  console.log(`Supervisor created: ${name} <${email.toLowerCase().trim()}>. Log in with that email and the password you just typed.`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
