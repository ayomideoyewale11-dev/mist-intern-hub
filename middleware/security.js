// Small, dependency-free protections used by app.js.

/* NoSQL injection: a JSON body such as {"email": {"$ne": ""}} can turn a lookup
   into "match anyone". Every route already checks its inputs are plain text, but
   this stops such a body at the door for all /api routes: any key that starts
   with "$", contains ".", or is "__proto__" is refused, however deeply nested. */
function hasBadKey(value, depth = 0) {
  if (depth > 8) return true; // absurdly deep: nothing here sends that
  if (Array.isArray(value)) return value.some((v) => hasBadKey(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.keys(value).some(
      (k) =>
        k.startsWith("$") ||
        k.includes(".") ||
        k === "__proto__" ||
        hasBadKey(value[k], depth + 1),
    );
  }
  return false;
}

function rejectOperatorKeys(req, res, next) {
  if (req.body && typeof req.body === "object" && hasBadKey(req.body)) {
    return res.status(400).json({ error: "That request could not be read." });
  }
  next();
}

/* Pages and API answers contain private data, so tell browsers and shared proxies
   not to keep a copy. Without this, the Back button after logging out can show
   the previous person's page from the browser's cache. */
function noStore(req, res, next) {
  res.set("Cache-Control", "no-store");
  next();
}

/* Reset links carry a secret in the address. Hide it in the server log, since
   logs are often shared or kept for a long time. */
function maskSecrets(url) {
  return String(url || "").replace(
    /(\/reset-password\/)[^/?#\s]+/i,
    "$1[hidden]",
  );
}

module.exports = { rejectOperatorKeys, noStore, maskSecrets };
