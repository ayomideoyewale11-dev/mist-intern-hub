// Fill the app with fake data so you can see paging and search.
//   node scripts/seedDemo.js supervisor@email.com
//       adds 60 fake interns (@demo.local) with tasks
//   node scripts/seedDemo.js supervisor@email.com intern@email.com --count 30
//       adds 30 fake tasks to ONE of your real interns (default 30)
//   node scripts/seedDemo.js supervisor@email.com --remove
//       deletes everything added by this script
// Seeded tasks are marked in the database and fake interns end in @demo.local.
// Use your local database, not production.
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const readline = require("node:readline/promises");
const User = require("../models/User");
const Task = require("../models/Task");
const {
  getDemoDatabaseUri,
  demoTaskCleanupFilter,
  legacyDemoTaskCleanupFilter,
} = require("../config/demoSeed");

const DAY = 24 * 60 * 60 * 1000;

(async () => {
  const args = process.argv.slice(2);
  const remove = args.includes("--remove");
  const ci = args.indexOf("--count");
  const count =
    ci >= 0 ? Math.min(500, Math.max(1, parseInt(args[ci + 1], 10) || 30)) : 30;
  const countIdx = ci >= 0 ? ci + 1 : -1; // the number after --count is not an email
  const plain = args.filter((x, i) => !x.startsWith("--") && i !== countIdx);
  const [email, internEmail] = plain;
  if (!email) {
    console.error(
      "Usage: node scripts/seedDemo.js supervisor@email.com [intern@email.com] [--count N] [--remove]",
    );
    process.exit(1);
  }
  const databaseUri = getDemoDatabaseUri();
  if (!databaseUri) {
    console.error("DATABASE_LOCAL is not set in .env; refusing to seed demo data.");
    process.exit(1);
  }
  await mongoose.connect(databaseUri);
  const sup = await User.findOne({ email: email.toLowerCase(), role: "admin" });
  if (!sup) {
    console.error("No supervisor with that email.");
    process.exit(1);
  }

  const demo = await User.find({
    email: /@demo\.local$/,
    supervisor: sup._id,
  }).select("_id");
  if (remove) {
    const ids = demo.map((u) => u._id);
    const t = await Task.deleteMany(demoTaskCleanupFilter(sup._id, ids));
    const legacyFilter = legacyDemoTaskCleanupFilter(sup._id, ids);
    const legacyTasks = await Task.find(legacyFilter).select("_id").lean();
    let legacyRemoved = 0;
    if (legacyTasks.length && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(
        `Found ${legacyTasks.length} older unmarked demo-shaped task(s) assigned to real interns. Type REMOVE to delete these possibly ambiguous records: `,
      );
      rl.close();
      if (answer === "REMOVE") {
        const legacyResult = await Task.deleteMany({
          ...legacyFilter,
          _id: { $in: legacyTasks.map((task) => task._id) },
        });
        legacyRemoved = legacyResult.deletedCount;
      }
    }
    const u = await User.deleteMany({ _id: { $in: ids } });
    console.log(
      `Removed ${u.deletedCount} demo interns and ${t.deletedCount + legacyRemoved} demo tasks.`,
    );
    if (legacyTasks.length && !legacyRemoved) {
      console.log(
        `Kept ${legacyTasks.length} older unmarked demo-shaped task(s). Run this command in an interactive terminal and type REMOVE at the prompt if they are all demo data.`,
      );
    }
  } else if (internEmail) {
    const intern = await User.findOne({
      email: internEmail.toLowerCase(),
      role: "intern",
      supervisor: sup._id,
    });
    if (!intern) {
      console.error("That is not one of this supervisor's interns.");
      process.exit(1);
    }
    const now = Date.now();
    const tasks = [];
    for (let n = 1; n <= count; n++) {
      const kind = n % 3; // a mix of open, overdue and submitted
      tasks.push({
        title: `[Demo] Task ${n}`,
        description: "Demo task.",
        dueDate: new Date(now + (kind === 0 ? -20 : 20) * DAY),
        assignedTo: intern._id,
        createdBy: sup._id,
        demoSeeded: true,
        createdAt: new Date(now - n * 60 * 1000),
        ...(kind === 1
          ? {
              submission: {
                link: "https://example.com",
                submittedAt: new Date(),
              },
            }
          : {}),
      });
    }
    await Task.insertMany(tasks);
    console.log(
      `Added ${count} demo tasks to ${intern.name}. Remove them with --remove.`,
    );
  } else if (demo.length) {
    console.log(
      "Demo data is already there. Run with --remove first to reset it.",
    );
  } else {
    const hash = await bcrypt.hash("Password123", 10);
    const now = Date.now();
    const interns = [];
    for (let i = 1; i <= 60; i++) {
      const ended = i > 40; // 40 current interns, 20 alumni
      interns.push({
        name: `Demo Intern ${String(i).padStart(2, "0")}`,
        email: `demo${i}@demo.local`,
        passwordHash: hash,
        role: "intern",
        supervisor: sup._id,
        active: !ended,
        internshipStartDate: new Date(now - 120 * DAY),
        internshipEndDate: new Date(now + (ended ? -10 : 90) * DAY),
      });
    }
    const made = await User.insertMany(interns);
    const tasks = [];
    made.forEach((intern, idx) => {
      const count = idx === 0 ? 80 : 3; // the first intern gets 80 tasks, the rest 3
      for (let n = 1; n <= count; n++) {
        const kind = n % 3; // a mix of open, overdue and submitted
        tasks.push({
          title: `[Demo] Task ${n} for ${intern.name}`,
          description: "Demo task.",
          dueDate: new Date(now + (kind === 0 ? -20 : 20) * DAY),
          assignedTo: intern._id,
          createdBy: sup._id,
          demoSeeded: true,
          createdAt: new Date(now - n * 60 * 1000),
          ...(kind === 1
            ? {
                submission: {
                  link: "https://example.com",
                  submittedAt: new Date(),
                },
              }
            : {}),
        });
      }
    });
    await Task.insertMany(tasks);
    console.log(
      `Added ${made.length} demo interns (40 current, 20 alumni) and ${tasks.length} tasks.`,
    );
    console.log(
      "Demo Intern 01 has 80 tasks. Remove it all later with --remove.",
    );
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
