/* Puts a backup made by scripts/backup.js back into the database named in
   .env (DATABASE).

   Usage:   node scripts/restore.js backups/2026-10-16T01-40-00

   Safety:
   - It shows which database it will write to and makes you type that
     database's name to confirm.
   - Anything currently in the collections found in the backup is REPLACED by
     the backup's copy. Collections that are not in the backup are left alone.
   - Restore into an empty or test database first if you are unsure.
   Restart the app afterwards (this also rebuilds any missing indexes). */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const mongoose = require("mongoose");

const { EJSON } = mongoose.mongo.BSON;
const { restoreCollection } = require("./restoreHelpers");

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    }),
  );
}

(async () => {
  const folder = process.argv[2];
  if (!folder) {
    console.error("Usage: node scripts/restore.js backups/<folder-name>");
    process.exit(1);
  }
  if (!process.env.DATABASE) {
    console.error("DATABASE is not set in .env");
    process.exit(1);
  }
  const dir = path.resolve(folder);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`Backup folder not found: ${dir}`);
    process.exit(1);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  if (!files.length) {
    console.error(
      "No .jsonl files in that folder, so it does not look like a backup.",
    );
    process.exit(1);
  }

  await mongoose.connect(process.env.DATABASE);
  const db = mongoose.connection.db;
  const name = db.databaseName;

  console.log(`\nBackup:   ${dir}`);
  console.log(`Database: "${name}"\n`);
  for (const f of files) {
    const col = f.replace(/\.jsonl$/, "");
    console.log(
      `  - ${col}: currently ${await db.collection(col).countDocuments()} record(s) (will be replaced)`,
    );
  }

  const answer = await ask(`\nType the database name ("${name}") to restore: `);
  if (answer !== name) {
    console.log("Names did not match. Nothing was changed.");
    await mongoose.disconnect();
    return;
  }

  for (const f of files) {
    const col = f.replace(/\.jsonl$/, "");
    const rl = readline.createInterface({
      input: fs.createReadStream(path.join(dir, f)),
      crlfDelay: Infinity,
    });
    const count = await restoreCollection(db, col, rl, EJSON);
    console.log(`  ${col}: restored ${count} record(s)`);
  }

  console.log("\nDone. Restart the app.");
  await mongoose.disconnect();
})().catch((e) => {
  console.error("Restore failed:", e.message);
  process.exit(1);
});
