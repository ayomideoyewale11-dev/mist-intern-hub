const request = require('supertest');
const bcrypt = require('bcrypt');
const User = require('../models/User');

// The server issues a CSRF cookie on the first request to anyone, logged in
// or not (see middleware/csrf.js). A real browser reads that cookie's value
// out of a <meta> tag and echoes it back as a header on every POST/PUT/DELETE;
// these tests have to do that same handshake manually, since there's no
// browser or page JS here to do it for them.
async function getCsrfToken(agent) {
  const res = await agent.get('/login');
  const setCookie = res.headers['set-cookie'] || [];
  const match = setCookie.join(';').match(/csrfToken=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

// Supervisors aren't created via the API (see scripts/createAdmin.js), so
// tests create one directly with the User model, then log in through the
// real route — the same two-step process a real supervisor goes through.
// If a user with that email already exists (e.g. makeIntern created the
// default supervisor first), it is reused rather than duplicated.
async function ensureAdmin(overrides = {}) {
  const user = { name: 'Mrs Admin', email: 'admin@test.com', password: 'Password123', ...overrides };
  const passwordHash = await bcrypt.hash(user.password, 10);
  let created = await User.findOne({ email: user.email });
  if (created) {
    created.passwordHash = passwordHash;
    await created.save();
  } else {
    created = await User.create({ name: user.name, email: user.email, passwordHash, role: 'admin' });
  }
  return { created, user };
}

async function makeAdmin(app, overrides = {}) {
  const { created, user } = await ensureAdmin(overrides);
  const agent = request.agent(app);
  const csrfToken = await getCsrfToken(agent);
  await agent.post('/api/auth/login').set('X-CSRF-Token', csrfToken).send({ email: user.email, password: user.password });
  return { agent, user: created, csrfToken };
}

// There's no public registration any more — a real intern account only ever
// comes from a supervisor's POST /api/auth/create-intern (see
// createIntern.test.js for that route's own tests). Most other tests just
// need "a valid logged-in intern" without caring how the account was made,
// so this creates one directly with the model.
// By default the intern belongs to the default test supervisor
// (admin@test.com), the same one makeAdmin() logs in. Pass
// { supervisor: someAdminUser } to attach them to a different supervisor.
async function makeIntern(app, overrides = {}) {
  const { supervisor: supervisorOverride, ...rest } = overrides;
  const supervisor = supervisorOverride || (await ensureAdmin()).created;
  const user = {
    name: 'Intern One', email: 'intern@test.com', password: 'Password123',
    internshipStartDate: '2026-01-01', internshipEndDate: '2099-01-01', // far future by default, so active: true
    ...rest,
  };
  const passwordHash = await bcrypt.hash(user.password, 10);
  const created = await User.create({
    name: user.name, email: user.email, passwordHash, role: 'intern', supervisor: supervisor._id,
    internshipStartDate: user.internshipStartDate, internshipEndDate: user.internshipEndDate,
  });
  const agent = request.agent(app);
  const csrfToken = await getCsrfToken(agent);
  await agent.post('/api/auth/login').set('X-CSRF-Token', csrfToken).send({ email: user.email, password: user.password });
  return { agent, user: created, csrfToken };
}

module.exports = { makeAdmin, makeIntern, getCsrfToken };
