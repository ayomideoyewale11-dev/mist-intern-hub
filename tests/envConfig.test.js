const fs = require("node:fs");
const path = require("node:path");

function findDuplicateKeys(contents) {
  const counts = new Map();

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) counts.set(match[1], (counts.get(match[1]) || 0) + 1);
  }

  return [...counts].filter(([, count]) => count > 1).map(([key]) => key);
}

describe("environment configuration", () => {
  it("detects duplicate variable definitions", () => {
    expect(
      findDuplicateKeys("PORT=3000\nSESSION_SECRET=first\nSESSION_SECRET=second"),
    ).toEqual(["SESSION_SECRET"]);
  });

  const localEnvPath = path.join(__dirname, "..", ".env");
  const localEnvTest = fs.existsSync(localEnvPath) ? it : it.skip;

  localEnvTest("does not repeat variable names in the local .env file", () => {
    const contents = fs.readFileSync(localEnvPath, "utf8");
    expect(findDuplicateKeys(contents)).toEqual([]);
  });
});
