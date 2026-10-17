require("dotenv").config();

// Every date calculation (reminder timing, "due tomorrow", the 07:00 jobs) uses this
// time zone, not the server's. Render's servers run on UTC, which is an hour behind
// Lagos. Set APP_TIMEZONE in .env to use a different one. Must run before anything else.
process.env.TZ = process.env.APP_TIMEZONE || "Africa/Lagos";
const mongoose = require("mongoose");

if (!process.env.DATABASE) {
  console.error("DATABASE is not set in .env");
  process.exit(1);
}

// Email is optional by design (see config/mailer.js — a missing setup just
// logs instead of sending), so this warns loudly at startup rather than
// failing silently every time an email would have gone out.
if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) {
  console.warn(
    "[startup] BREVO_API_KEY / BREVO_SENDER_EMAIL not set — emails will be logged, not sent. Configure these environment variables to send email.",
  );
}

// Render sets RENDER=true. Running there without NODE_ENV=production would switch off secure
// cookies and allow the built-in development session secret, so refuse to start.
if (process.env.RENDER && process.env.NODE_ENV !== "production") {
  console.error(
    'NODE_ENV must be "production" on Render. Add it under Environment, then redeploy.',
  );
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const createApp = require("./app"); // required after dotenv so env vars are available
const { startScheduler } = require("./config/scheduler");

mongoose
  .connect(process.env.DATABASE)
  .then(() => {
    console.log("Connected to MongoDB");
    const app = createApp(); // built only now, so the session store can reuse this connection
    app.listen(PORT, () =>
      console.log(`Server running at http://localhost:${PORT}`),
    );
    startScheduler(); // reminder + weekly summary emails — never started during tests
  })
  .catch((err) => {
    console.error("MongoDB connection failed:", err.message);
    process.exit(1);
  });
