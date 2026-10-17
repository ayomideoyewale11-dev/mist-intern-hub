// Moves everything one supervisor owns to another supervisor (e.g. when someone retires):
// their interns, every task, and the audit history. Nothing is deleted.
//   node scripts/handOver.js old-supervisor@email.com new-supervisor@email.com [--yes]
// The old account is left as it is: afterwards you can delete it with scripts/deleteUser.js
// (it will own nothing by then, so only the account itself goes). Run `node scripts/backup.js` first.
require('dotenv').config();
const readline = require('readline');
const mongoose = require('mongoose');
const User = require('../models/User');
const { handOver, countForHandOver } = require('../config/accountRemoval');

const ask = (q) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); resolve(a); });
});

(async () => {
  const args = process.argv.slice(2);
  const yes = args.includes('--yes');
  const [fromEmail, toEmail] = args.filter((a) => !a.startsWith('--')).map((e) => e.toLowerCase().trim());
  if (!fromEmail || !toEmail) { console.error('Usage: node scripts/handOver.js old@email.com new@email.com [--yes]'); process.exit(1); }

  await mongoose.connect(process.env.DATABASE);
  const from = await User.findOne({ email: fromEmail, role: 'admin' });
  const to = await User.findOne({ email: toEmail, role: 'admin' });
  if (!from) { console.error('The first email is not a supervisor.'); process.exit(1); }
  if (!to) { console.error('The second email is not a supervisor.'); process.exit(1); }
  if (String(from._id) === String(to._id)) { console.error('Choose two different supervisors.'); process.exit(1); }

  const c = await countForHandOver(from);
  console.log(`\nHand over from ${from.name} <${from.email}> to ${to.name} <${to.email}>:`);
  console.log(`  - ${c.interns} intern(s), ${c.tasks} task(s) and ${c.logs} audit log entr${c.logs === 1 ? 'y' : 'ies'} will move.`);
  console.log('Nothing is deleted. Interns keep their passwords and history.');

  if (!yes) {
    const typed = await ask('\nType YES to continue: ');
    if (typed.trim() !== 'YES') { console.log('Cancelled. Nothing was changed.'); await mongoose.disconnect(); return; }
  }
  if (!yes) {
    const latest = await countForHandOver(from);
    if (JSON.stringify(latest) !== JSON.stringify(c)) {
      console.error('Supervisor data changed while awaiting confirmation. Nothing was moved; run the command again to review the updated counts.');
      await mongoose.disconnect(); return;
    }
  }

  const done = await handOver(from, to);
  console.log(`\nMoved ${done.interns} intern(s), ${done.tasks} task(s) and ${done.logs} audit log entr${done.logs === 1 ? 'y' : 'ies'}.`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
