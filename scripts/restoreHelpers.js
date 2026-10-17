const crypto = require("crypto");

const BATCH = 200;

async function restoreCollection(db, name, lines, EJSON) {
  if (!name || name.startsWith("system.")) {
    throw new Error(`Refusing to restore collection: ${name}`);
  }
  const stagingName = `__restore_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
  const staging = db.collection(stagingName);
  let count = 0;
  let batch = [];

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      batch.push(EJSON.parse(line, { relaxed: false }));
      if (batch.length >= BATCH) {
        await staging.insertMany(batch);
        count += batch.length;
        batch = [];
      }
    }
    if (batch.length) {
      await staging.insertMany(batch);
      count += batch.length;
    }
    if (count === 0) {
      await db.createCollection(stagingName);
    }

    const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
    if (exists) {
      const indexes = await db.collection(name).listIndexes().toArray();
      for (const index of indexes) {
        if (index.name === "_id_") continue;
        const { key, ns, v, ...options } = index;
        await staging.createIndex(key, options);
      }
    }

    await staging.rename(name, { dropTarget: true });
    return count;
  } catch (error) {
    try {
      await staging.drop();
    } catch {
      // The staging collection may not exist if parsing failed before creation.
    }
    throw error;
  }
}

module.exports = { restoreCollection };
