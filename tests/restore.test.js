const mongoose = require('mongoose');
const { setupTestDatabase, teardownTestDatabase, clearDatabase } = require('./testApp');
const { restoreCollection } = require('../scripts/restoreHelpers');

let db;
const { EJSON } = mongoose.mongo.BSON;

beforeAll(async () => {
  await setupTestDatabase();
  db = mongoose.connection.db;
}, 30000);
afterEach(clearDatabase);
afterAll(teardownTestDatabase);

async function* lines(values) {
  yield* values;
}

describe('restoreCollection', () => {
  it('leaves the existing collection intact if a backup row is malformed', async () => {
    const collection = db.collection('restore_records');
    await collection.insertOne({ _id: 'existing', value: 'keep me' });
    const valid = EJSON.stringify({ _id: 'replacement', value: 'new' }, { relaxed: false });

    await expect(restoreCollection(db, 'restore_records', lines([valid, '{invalid']), EJSON)).rejects.toThrow();

    expect(await collection.findOne({ _id: 'existing' })).toEqual({ _id: 'existing', value: 'keep me' });
    expect(await collection.findOne({ _id: 'replacement' })).toBeNull();
  });

  it('replaces the collection after a successful import and preserves its indexes', async () => {
    const collection = db.collection('restore_records');
    await collection.insertOne({ _id: 'existing', email: 'old@example.com' });
    await collection.createIndex({ email: 1 }, { unique: true, name: 'email_unique' });
    const rows = [
      EJSON.stringify({ _id: 'new-a', email: 'a@example.com' }, { relaxed: false }),
      EJSON.stringify({ _id: 'new-b', email: 'b@example.com' }, { relaxed: false }),
    ];

    await expect(restoreCollection(db, 'restore_records', lines(rows), EJSON)).resolves.toBe(2);

    const restored = db.collection('restore_records');
    expect(await restored.find().sort({ _id: 1 }).toArray()).toEqual([
      { _id: 'new-a', email: 'a@example.com' },
      { _id: 'new-b', email: 'b@example.com' },
    ]);
    expect((await restored.listIndexes().toArray()).map((index) => index.name)).toContain('email_unique');
  });

  it('replaces an existing collection with an empty backup', async () => {
    await db.collection('restore_records').insertOne({ _id: 'existing', value: 'remove me' });

    await expect(restoreCollection(db, 'restore_records', lines([]), EJSON)).resolves.toBe(0);

    const restored = db.collection('restore_records');
    expect(await restored.countDocuments()).toBe(0);
    expect((await restored.listIndexes().toArray()).map((index) => index.name)).toContain('email_unique');
  });
});
