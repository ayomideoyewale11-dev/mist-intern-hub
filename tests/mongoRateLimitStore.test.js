const mongoose = require('mongoose');
const { setupTestDatabase, teardownTestDatabase, clearDatabase } = require('./testApp');
const MongoRateLimitStore = require('../middleware/mongoRateLimitStore');

beforeAll(async () => { await setupTestDatabase(); }, 30000);
afterEach(clearDatabase);
afterAll(teardownTestDatabase);

describe('MongoRateLimitStore', () => {
  it('shares a counter between independent store instances using the same namespace', async () => {
    const firstProcessStore = new MongoRateLimitStore('shared-test-limit');
    const secondProcessStore = new MongoRateLimitStore('shared-test-limit');
    expect(firstProcessStore.localKeys).toBe(true);
    expect(secondProcessStore.localKeys).toBe(true);
    firstProcessStore.init({ windowMs: 60_000 });
    secondProcessStore.init({ windowMs: 60_000 });

    const first = await firstProcessStore.increment('client-key');
    const second = await secondProcessStore.increment('client-key');

    expect(first.totalHits).toBe(1);
    expect(second.totalHits).toBe(2);
    expect(second.resetTime).toBeInstanceOf(Date);
    expect(await mongoose.connection.db.collection('rateLimitCounters').countDocuments()).toBe(1);
  });

  it('decrements, resets individual keys, and resets the namespace', async () => {
    const store = new MongoRateLimitStore('reset-test');
    store.init({ windowMs: 60_000 });
    await store.increment('one');
    await store.increment('two');
    await store.decrement('one');
    const one = await store.increment('one');
    expect(one.totalHits).toBe(1);
    await store.resetKey('one');
    expect((await store.increment('one')).totalHits).toBe(1);
    await store.resetAll();
    expect((await store.increment('two')).totalHits).toBe(1);
  });
});
