// Usage: node scripts/backup.js
// Saves a copy of the whole database (tasks, users, audit log and uploaded
// files) into backups/<date-time>/ so you can recover if something goes wrong.
// Needs DATABASE in your .env (the same one the app uses).
//
// Each collection becomes one file with one record per line (.jsonl).
// KEEP THE BACKUP PRIVATE: it contains names, emails, password hashes and the
// files interns uploaded. Never commit it to GitHub.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const { EJSON } = mongoose.mongo.BSON;

(async () => {
  if (!process.env.DATABASE) {
    console.error("DATABASE is not set. Put it in your .env file first.");
    process.exit(1);
  }
  await mongoose.connect(process.env.DATABASE);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(__dirname, "..", "backups", stamp);
  fs.mkdirSync(dir, { recursive: true });

  const collections = await mongoose.connection.db.listCollections().toArray();
  for (const { name } of collections) {
    if (name.startsWith("system.")) continue;
    const out = fs.createWriteStream(path.join(dir, `${name}.jsonl`));
    let count = 0;
    // one record at a time, so a big collection never has to fit in memory
    for await (const doc of mongoose.connection.db.collection(name).find()) {
      if (!out.write(EJSON.stringify(doc, { relaxed: false }) + "\n")) {
        await new Promise((r) => out.once("drain", r));
      }
      count++;
    }
    await new Promise((r) => out.end(r));
    console.log(`  ${name}: ${count} record(s)`);
  }
  console.log(`\nBackup saved in: ${dir}`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error("Backup failed:", e.message);
  process.exit(1);
});
