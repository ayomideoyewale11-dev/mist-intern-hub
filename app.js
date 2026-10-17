const express = require("express");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const MongoRateLimitStore = require("./middleware/mongoRateLimitStore");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const path = require("path");
const mongoose = require("mongoose");

const authRoutes = require("./routes/authRoutes");
const taskRoutes = require("./routes/taskRoutes");
const viewRoutes = require("./routes/viewRoutes");
const cronRoutes = require("./routes/cronRoutes");
const suggestRoutes = require("./routes/suggestRoutes");
const { issueCsrfToken, verifyCsrfToken } = require("./middleware/csrf");
const {
  rejectOperatorKeys,
  noStore,
  maskSecrets,
} = require("./middleware/security");
const { isPublicHttpsUrl } = require("./config/validate");
const { localDateKey } = require("./config/dateBoundaries");

const isProd = process.env.NODE_ENV === "production";
const SESSION_IDLE_SECONDS = 60 * 60; // logged out after an hour with no activity
if (isProd && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production.");
}
if (isProd && !isPublicHttpsUrl(process.env.APP_URL)) {
  throw new Error("APP_URL must be a public HTTPS URL in production so email links use the public address.");
}

// Built as a function, called only after mongoose has connected (see
// server.js), so the session store can reuse that one connection instead of
// opening a second, independent connection to the same database. Two
// separate connections racing at startup was what caused the app to crash
// if either one had any trouble — this removes that risk entirely.
function createApp() {
  const app = express();
  if (isProd) app.set("trust proxy", 1); // needed for secure cookies behind a proxy

  // /healthz is mounted before everything else: no auth, no rate limit, no
  // logging noise — just a plain signal for uptime monitors and Render/etc.
  app.get("/healthz", (req, res) => {
    const dbOk = mongoose.connection.readyState === 1; // 1 = connected
    res
      .status(dbOk ? 200 : 503)
      .json({
        status: dbOk ? "ok" : "degraded",
        db: dbOk ? "connected" : "disconnected",
      });
  });

  morgan.token("url", (req) => maskSecrets(req.originalUrl || req.url)); // keeps password-reset secrets out of the log
  morgan.token("referrer", (req) => {
    const referrer = req.headers.referer || req.headers.referrer;
    return referrer ? maskSecrets(referrer) : "-";
  }); // reset forms send their token-bearing page as the same-origin Referer
  app.use(morgan(isProd ? "combined" : "dev"));

  // 'upgrade-insecure-requests' is disabled so plain-http localhost still works
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: { "upgrade-insecure-requests": null },
      },
    }),
  );
  // 64kb: room for a 5000-character description plus the list of up to 500 interns when assigning a task to many at once
  app.use(express.json({ limit: "64kb" }));
  // Express 5 leaves req.body undefined when no body parser matched the request.
  // Routes can then return a controlled validation error instead of throwing.
  app.use((req, res, next) => {
    if (req.body === undefined) req.body = {};
    next();
  });
  app.use("/api", rejectOperatorKeys); // refuse {"$ne": ...}-style bodies before any route sees them
  app.use(cookieParser());

  app.use(
    session({
      name: "mist.sid", // new name: old login cookies are ignored once
      secret: process.env.SESSION_SECRET || "dev-secret-change-me",
      resave: false,
      saveUninitialized: false,
      // Idle timeout: each request extends the session by an hour, then it expires
      // on the server. There is no maxAge on the cookie on purpose, which makes it a
      // "session cookie" that the browser throws away when it is fully closed.
      rolling: true,
      store: MongoStore.create({
        client: mongoose.connection.getClient(),
        ttl: SESSION_IDLE_SECONDS,
        touchAfter: 60,
      }),
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: isProd,
      },
    }),
  );

  app.use(issueCsrfToken); // every response from here on carries/refreshes the CSRF cookie

  app.use(express.static(path.join(__dirname, "public")));
  app.use(noStore); // everything below is private: pages, API answers and downloads

  app.set("view engine", "pug");
  app.set("views", path.join(__dirname, "views"));

  app.use((req, res, next) => {
    res.locals.appDate = localDateKey().toISOString().slice(0, 10);
    next();
  });

  app.use("/", viewRoutes);

  // Guessing limits. Only FAILED logins count, so a whole office behind one shared
  // IP can log in normally, while someone guessing passwords is stopped quickly.
  const rl = (namespace, max, extra = {}) =>
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        error: "Too many attempts. Please wait a few minutes and try again.",
      },
      store: new MongoRateLimitStore(namespace),
      ...extra,
    });
  // Per account as well as per address: someone guessing one person's password from many
  // different addresses is still stopped after 10 wrong tries (the account waits 15 minutes).
  app.use(
    "/api/auth/login",
    rl("auth-login-account", 10, {
      skipSuccessfulRequests: true,
      keyGenerator: (req) =>
        `email:${String(req.body?.email || "")
          .toLowerCase()
          .trim()
          .slice(0, 200)}`,
      message: {
        error:
          "Too many failed attempts for this account. Please wait 15 minutes and try again.",
      },
    }),
  );
  app.use("/api/auth/login", rl("auth-login-ip", 20, { skipSuccessfulRequests: true }));
  app.use("/api/auth/forgot-password", rl("auth-forgot", 20));
  app.use("/api/auth/reset-password", rl("auth-reset", 20));
  app.use("/api/auth", rl("auth-general", 300)); // everything else, per IP, generous enough for a shared network
  app.use("/api/auth", verifyCsrfToken, authRoutes);

  // Looser than /api/auth, since every request here is already authenticated —
  // this is mainly to stop one account from hammering the endpoints (file
  // uploads especially), not to gate normal day-to-day use.
  app.use(
    "/api/tasks",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
      store: new MongoRateLimitStore("tasks"),
    }),
  );
  app.use("/api/tasks", verifyCsrfToken, taskRoutes);

  // Search-as-you-type suggestions: read-only, GET only, so no CSRF token is needed.
  // The limit is higher because one search can fire several requests.
  app.use(
    "/api/suggest",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 600,
      standardHeaders: true,
      legacyHeaders: false,
      store: new MongoRateLimitStore("suggest"),
    }),
  );
  app.use("/api/suggest", suggestRoutes);

  // Called by an external scheduler, not a browser — so deliberately NOT
  // behind verifyCsrfToken (there's no cookie or session to protect). The
  // shared secret in routes/cronRoutes.js is what authenticates the caller;
  // the tight limit here just makes guessing that secret impractical.
  app.use(
    "/api/cron",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 20,
      standardHeaders: true,
      legacyHeaders: false,
      store: new MongoRateLimitStore("cron"),
    }),
  );
  app.use("/api/cron", cronRoutes);

  // Error handler must come AFTER the routes
  app.use((err, req, res, next) => {
    // A request the client got wrong (broken JSON, body too big) is the client's problem (4xx), not a server fault
    const status = err.status || err.statusCode;
    if (status >= 400 && status < 500) {
      return res
        .status(status)
        .json({
          error:
            status === 413
              ? "That request is too large."
              : "That request could not be read.",
        });
    }
    console.error(err.stack);
    res.status(500).json({ error: "Something went wrong." });
  });

  return app;
}

module.exports = createApp;
