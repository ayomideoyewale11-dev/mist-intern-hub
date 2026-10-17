const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { runDailyJob, runWeeklyJob } = require("../config/scheduler");

// These are called by an external scheduler (e.g. cron-job.org), not a
// browser — so there's no session or CSRF token involved. The only thing
// proving the caller is legitimate is a shared secret in a request header.
function verifyCronSecret(req, res, next) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return res
      .status(503)
      .json({ error: "CRON_SECRET is not configured on the server." });
  }
  const provided = req.headers["x-cron-secret"];
  const valid =
    typeof provided === "string" &&
    Buffer.byteLength(provided) === Buffer.byteLength(expected) &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!valid) return res.status(401).json({ error: "Invalid cron secret." });
  next();
}

/* POST /api/cron/daily — due-soon + overdue reminders, and ending internships */
router.post("/daily", verifyCronSecret, async (req, res) => {
  try {
    res.json(await runDailyJob());
  } catch (err) {
    console.error("[cron] Daily job failed:", err.message);
    res.status(500).json({ error: "Daily job failed." });
  }
});

/* POST /api/cron/weekly — each supervisor's weekly summary email */
router.post("/weekly", verifyCronSecret, async (req, res) => {
  try {
    res.json(await runWeeklyJob());
  } catch (err) {
    console.error("[cron] Weekly job failed:", err.message);
    res.status(500).json({ error: "Weekly job failed." });
  }
});

module.exports = router;
