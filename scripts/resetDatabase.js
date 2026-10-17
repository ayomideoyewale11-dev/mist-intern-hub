/* Wipes EVERYTHING in the database named in .env (DATABASE):
   users, tasks, audit log, login sessions, and uploaded files (GridFS).
   This cannot be undone.

   Usage:   node scripts/resetDatabase.js
   It shows which database it is about to wipe and makes you type that
   database's name to confirm. Afterwards, create a new supervisor with:
     node scripts/createAdmin.js "Name" email */
require("dotenv").config();
const mongoose = require("mongoose");
const readline = require("readline");

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

(async () => {
  if (!process.env.DATABASE) {
    console.error("DATABASE is not set in .env");
    process.exit(1);
  }

  await mongoose.connect(process.env.DATABASE);
  const db = mongoose.connection.db;
  const name = db.databaseName;

  const collections = await db.collections();
  console.log(`\nConnected to database: "${name}"`);
  if (!collections.length) {
    console.log("It is already empty. Nothing to do.");
    await mongoose.disconnect();
    return;
  }
  for (const c of collections) {
    console.log(
      `  - ${c.collectionName}: ${await c.countDocuments()} document(s)`,
    );
  }

  const answer = await ask(
    `\nThis will permanently delete ALL of the above. Type the database name ("${name}") to confirm: `,
  );
  if (answer !== name) {
    console.log("Names did not match. Nothing was deleted.");
    await mongoose.disconnect();
    return;
  }

  await db.dropDatabase();
  console.log(
    `\nDone. "${name}" has been wiped. Restart the app, then create a new supervisor with scripts/createAdmin.js.`,
  );
  await mongoose.disconnect();
})().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
