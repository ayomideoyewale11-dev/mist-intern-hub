// Usage: node scripts/createAdmin.js "Name" email@example.com
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const User = require("../models/User");
const { validNewPassword } = require("../config/validate");
const readSecret = require("./readSecret");

(async () => {
  const [name, email] = process.argv.slice(2);
  if (!name || !email) {
    console.error('Usage: node scripts/createAdmin.js "Name" email');
    process.exit(1);
  }
  const password = await readSecret();
  if (!validNewPassword(password)) {
    console.error("Password must be at least 8 characters and no more than 72 UTF-8 bytes.");
    process.exit(1);
  }
  await mongoose.connect(process.env.DATABASE);
  await User.create({
    name,
    email,
    passwordHash: await bcrypt.hash(password, 10),
    role: "admin",
  });
  console.log("Supervisor created.");
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
