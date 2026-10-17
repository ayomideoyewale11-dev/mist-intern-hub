const mongoose = require("mongoose");

// Persist rate-limit counters in Mongo so every app process enforces the same
// limits. Each limiter gets a stable namespace, and Mongo expires old windows.
class MongoRateLimitStore {
  constructor(namespace) {
    if (!namespace) throw new TypeError("A rate-limit namespace is required.");
    this.namespace = namespace;
    // Each limiter has its own instance and namespace. This tells
    // express-rate-limit's duplicate-count validation to identify this store
    // by instance instead of treating every MongoRateLimitStore as one store.
    this.localKeys = true;
    this.windowMs = 15 * 60 * 1000;
    this.collection = null;
    this.initPromise = null;
  }

  init(options) {
    this.windowMs = options.windowMs;
    this.collection = mongoose.connection.db.collection("rateLimitCounters");
    this.initPromise = this.collection.createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: "rate_limit_expiry" },
    );
  }

  async increment(key) {
    await this.initPromise;
    const id = `${this.namespace}:${key}`;
    const now = new Date();
    const nextExpiry = new Date(now.getTime() + this.windowMs);
    const active = { $gt: ["$expiresAt", now] };
    let result;
    try {
      result = await this.collection.findOneAndUpdate(
        { _id: id },
        [
          {
            $set: {
              totalHits: {
                $cond: [active, { $add: [{ $ifNull: ["$totalHits", 0] }, 1] }, 1],
              },
              expiresAt: { $cond: [active, "$expiresAt", nextExpiry] },
            },
          },
        ],
        { upsert: true, returnDocument: "after" },
      );
    } catch (error) {
      // Concurrent first requests can race to upsert the same key. Retry once
      // without upsert after the other request creates the document.
      if (error.code !== 11000) throw error;
      result = await this.collection.findOneAndUpdate(
        { _id: id },
        [
          {
            $set: {
              totalHits: {
                $cond: [active, { $add: [{ $ifNull: ["$totalHits", 0] }, 1] }, 1],
              },
              expiresAt: { $cond: [active, "$expiresAt", nextExpiry] },
            },
          },
        ],
        { returnDocument: "after" },
      );
    }
    const doc = result?.value || result;
    return { totalHits: doc.totalHits, resetTime: new Date(doc.expiresAt) };
  }

  async decrement(key) {
    await this.initPromise;
    await this.collection.updateOne(
      { _id: `${this.namespace}:${key}`, expiresAt: { $gt: new Date() } },
      [{ $set: { totalHits: { $max: [0, { $subtract: ["$totalHits", 1] }] } } }],
    );
  }

  async resetKey(key) {
    await this.initPromise;
    await this.collection.deleteOne({ _id: `${this.namespace}:${key}` });
  }

  async resetAll() {
    await this.initPromise;
    await this.collection.deleteMany({ _id: new RegExp(`^${this.namespace}:`) });
  }
}

module.exports = MongoRateLimitStore;
