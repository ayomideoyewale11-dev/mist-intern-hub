const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongod;
let app;

// Starts an in-memory MongoDB, connects mongoose to it, then builds the app —
// in that order, so the session store can reuse this same connection (see
// app.js), matching exactly how server.js does it for the real app.
async function setupTestDatabase() {
  mongod = await MongoMemoryServer.create();
  process.env.DATABASE = mongod.getUri();
  process.env.SESSION_SECRET = 'test-secret';
  await mongoose.connect(process.env.DATABASE);
}

async function setupTestApp() {
  await setupTestDatabase();
  const createApp = require('../app');
  app = createApp();
  return app;
}

async function teardownTestDatabase() {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

const teardownTestApp = teardownTestDatabase;

async function clearDatabase() {
  const collections = await mongoose.connection.db.collections();
  for (const collection of collections) await collection.deleteMany({});
}

module.exports = {
  setupTestApp,
  teardownTestApp,
  setupTestDatabase,
  teardownTestDatabase,
  clearDatabase,
};
