const crypto = require("crypto");

const COOKIE_NAME = "csrfToken";
const HEADER_NAME = "x-csrf-token";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Runs on every request. Issues a token cookie the first time a visitor is
// seen, and makes it available to every Pug template as `csrfToken` (see
// views/layout.pug, which puts it in a <meta> tag for the page's JS to read).
function issueCsrfToken(req, res, next) {
  let token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    token = crypto.randomBytes(32).toString("hex");
    res.cookie(COOKIE_NAME, token, {
      httpOnly: false, // the page's own JS needs to read this one, unlike the session cookie
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });
  }
  res.locals.csrfToken = token;
  next();
}

// Mounted on the API routers. Rejects any state-changing request whose
// X-CSRF-Token header doesn't match the cookie set above.
function verifyCsrfToken(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const cookieToken = req.cookies?.[COOKIE_NAME];
  const headerToken = req.headers[HEADER_NAME];
  const valid =
    cookieToken &&
    headerToken &&
    Buffer.byteLength(cookieToken) === Buffer.byteLength(headerToken) &&
    crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken));

  if (!valid)
    return res
      .status(403)
      .json({
        error:
          "Invalid or missing CSRF token. Please refresh the page and try again.",
      });
  next();
}

module.exports = { issueCsrfToken, verifyCsrfToken };
