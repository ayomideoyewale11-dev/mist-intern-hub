/* Shared helpers for list pages that search and page on the server
   (Archive, Interns, Alumni and the two task-history pages). */
const { localDateKey } = require("./dateBoundaries");

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A "back" address is only trusted when it is one of our own supervisor pages
// (optionally with a page number or search), never an address on another site.
const BACK_OK =
  /^\/(?:admin|audit-log|archive|interns|alumni|my-history)(?:\/[a-f0-9]{24})?(?:\?[\w=&%.+~-]*)?(?:#[\w-]*)?$/;
const BACK_LABEL = {
  "/admin": "Dashboard",
  "/audit-log": "Audit log",
  "/archive": "Archive",
  "/interns": "Interns",
  "/alumni": "Alumni",
  "/my-history": "My History",
};
const MAX_PAGE = 10000;
function parsePage(value) {
  const page = Number(value);
  if (!Number.isFinite(page) || !Number.isInteger(page) || page < 1) return 1;
  return Math.min(page, MAX_PAGE);
}
function safeBack(raw) {
  const b = typeof raw === "string" ? raw : "";
  return b.length <= 400 && BACK_OK.test(b) ? b : "";
}
// { href, label } for a Back link: the page the person came from, else the fallback
function backTarget(raw, fallbackHref, fallbackLabel) {
  const b = safeBack(raw);
  if (!b) return { href: fallbackHref, label: fallbackLabel };
  const path = b.split(/[?#]/)[0];
  return { href: b, label: BACK_LABEL[path] || "Intern history" };
}

function listParams(req) {
  const page = parsePage(req.query.page);
  const q = String(req.query.q || "")
    .trim()
    .slice(0, 100);
  const status = ["open", "overdue", "submitted"].includes(req.query.status)
    ? req.query.status
    : "";
  const back = safeBack(req.query.back); // the page the person came from, for a Back link
  return { page, q, status, back };
}

// Mongo condition matching one of the three computed task statuses
function statusCondition(status) {
  const cutoff = localDateKey();
  if (status === "submitted")
    return { "submission.submittedAt": { $ne: null } };
  if (status === "open")
    return { "submission.submittedAt": null, dueDate: { $gte: cutoff } };
  if (status === "overdue")
    return { "submission.submittedAt": null, dueDate: { $lt: cutoff } };
  return null;
}

// The address of page p, keeping the search and filter
function pageHref(basePath, { q, status, back }, p) {
  const sp = new URLSearchParams();
  if (q) sp.set("q", q);
  if (status) sp.set("status", status);
  if (back) sp.set("back", back);
  if (p > 1) sp.set("page", String(p));
  const s = sp.toString();
  return s ? `${basePath}?${s}` : basePath;
}

// Someone asked for a page past the end (an old bookmark, or the list got shorter):
// send them to the last real page. Returns true when it has redirected.
function pastEnd(res, basePath, lp, total, pageSize) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (lp.page <= totalPages) return false;
  res.redirect(pageHref(basePath, lp, totalPages));
  return true;
}

// Pager info for the pager partial; keeps the search and filter in the links
function buildPager(basePath, lp, total, pageSize) {
  const { page } = lp;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const href = (p) => pageHref(basePath, lp, p);
  return {
    page,
    totalPages,
    total,
    prev: page > 1 ? href(page - 1) : null,
    next: page < totalPages ? href(page + 1) : null,
  };
}

module.exports = {
  escapeRegex,
  safeBack,
  backTarget,
  listParams,
  statusCondition,
  buildPager,
  pastEnd,
  parsePage,
  MAX_PAGE,
};
