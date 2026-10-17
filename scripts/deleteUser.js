// Permanently deletes ONE account.
//   node scripts/deleteUser.js person@email.com [--yes]
//
// - An intern: the intern, all their tasks, their uploaded files and their logins are deleted.
// - A supervisor: the supervisor AND every intern they own, all those interns' tasks, files and
//   logins are deleted. To keep the interns and tasks, run scripts/handOver.js first.
// The audit log is always kept. THIS CANNOT BE UNDONE: run `node scripts/backup.js` first.
// It shows what will be deleted and asks you to type the email to confirm (--yes skips the question).
require('dotenv').config();
const readline = require('readline');
const mongoose = require('mongoose');
const User = require('../models/User');
const {
  removeIntern, removeSupervisor, countForInterns, countForSupervisor,
} = require('../config/accountRemoval');

const ask = (q) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); resolve(a); });
});

(async () => {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes');
  const email = (args.find((a) => !a.startsWith('--')) || '').toLowerCase().trim();
  if (!email) { console.error('Usage: node scripts/deleteUser.js person@email.com [--yes]'); process.exit(1); }

  await mongoose.connect(process.env.DATABASE);
  const user = await User.findOne({ email });
  if (!user) { console.error('No account with that email.'); process.exit(1); }

  const isSup = user.role === 'admin';
  const c = isSup ? await countForSupervisor(user) : await countForInterns([user._id]);
  console.log(`\n${isSup ? 'SUPERVISOR' : 'Intern'}: ${user.name} <${user.email}>`);
  console.log('This will permanently delete:');
  if (isSup) console.log('  - the supervisor account');
  console.log(`  - ${c.interns} intern account(s)${isSup ? ' (every intern this supervisor owns)' : ''}`);
  console.log(`  - ${c.tasks} task(s) and ${c.files} uploaded file(s)`);
  console.log('  - their logins (they are signed out)');
  console.log('The audit log is kept.');
  if (isSup && c.interns > 0) console.log('\nTo keep those interns and tasks instead, hand them to another supervisor first: node scripts/handOver.js');

  if (!yes) {
    const typed = await ask(`\nType the email (${user.email}) to confirm, anything else cancels: `);
    if (typed.trim().toLowerCase() !== user.email) { console.log('Cancelled. Nothing was deleted.'); await mongoose.disconnect(); return; }
  }

  if (!yes) {
    const latest = isSup ? await countForSupervisor(user) : await countForInterns([user._id]);
    if (JSON.stringify(latest) !== JSON.stringify(c)) {
      console.error('Account data changed while awaiting confirmation. Nothing was deleted; run the command again to review the updated counts.');
      await mongoose.disconnect(); return;
    }
  }

  const done = isSup ? await removeSupervisor(user) : await removeIntern(user);
  console.log(`\nDeleted ${done.supervisors || 0} supervisor, ${done.interns} intern(s), ${done.tasks} task(s), ${done.files} file(s); ended ${done.sessions} login session(s).`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
