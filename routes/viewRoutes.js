const express = require("express");
const router = express.Router();
const {
  requireLoginPage,
  requireRolePage,
} = require("../middleware/authGuards");
const sweepEnded = require("../middleware/sweepEnded");
const page = require("../controllers/pageController");
const dashboard = require("../controllers/dashboardController");
const history = require("../controllers/historyController");
const archive = require("../controllers/archiveController");
const interns = require("../controllers/internPageController");
const taskPage = require("../controllers/taskPageController");

const admin = [requireLoginPage, requireRolePage("admin")];
const intern = [requireLoginPage, requireRolePage("intern")];

// Every page can build a "Back" link to itself from this (page number and search included)
router.use((req, res, next) => {
  res.locals.here = req.originalUrl;
  next();
});

// Public pages. There is no public registration: a supervisor creates every
// intern account (POST /api/auth/create-intern), so /register just goes to the login page.
router.get("/", page.home);
router.get("/login", page.login);
router.get("/register", page.register);
router.get("/forgot-password", page.forgotPage);
router.get("/reset-password/:token", page.resetPage);

// Both roles
router.get("/account", requireLoginPage, page.account);
router.get("/tasks/:id", requireLoginPage, taskPage.show);

// Supervisor
router.get("/admin", ...admin, sweepEnded, dashboard.admin);
router.get("/archive", ...admin, sweepEnded, archive.archive);
router.get("/archive/export.pdf", ...admin, archive.exportPdf);
router.get("/audit-log", ...admin, archive.auditLog);
router.get("/audit-log/export.csv", ...admin, archive.exportAuditLog);
router.get("/interns", ...admin, sweepEnded, interns.list);
router.get("/interns/new", ...admin, interns.newForm); // before /interns/:id, or "new" would be read as an id
router.get("/interns/:id/edit", ...admin, interns.edit);
router.get("/interns/:id/export.pdf", ...admin, interns.exportPdf);
router.get("/interns/:id", ...admin, interns.history);
router.get("/alumni", ...admin, sweepEnded, interns.alumni);

// Intern
router.get("/intern", ...intern, dashboard.intern);
router.get("/my-history/export.pdf", ...intern, history.exportPdf);
router.get("/my-history", ...intern, history.myHistory);

module.exports = router;
