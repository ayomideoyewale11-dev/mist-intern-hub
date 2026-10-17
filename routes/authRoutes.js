const express = require("express");
const router = express.Router();
const { requireLogin, requireRole } = require("../middleware/authGuards");
const auth = require("../controllers/authController");
const interns = require("../controllers/internAccountController");

// Public routes
router.post("/login", auth.login);
router.post("/logout", auth.logout);
router.post("/forgot-password", auth.forgotPassword);
router.post("/reset-password/:token", auth.resetPassword);

// Logged in
router.get("/me", requireLogin, auth.me);
router.post("/change-password", requireLogin, auth.changePassword);

// Supervisor manages their interns
router.post(
  "/create-intern",
  requireLogin,
  requireRole("admin"),
  interns.create,
);
router.put("/interns/:id", requireLogin, requireRole("admin"), interns.update);
router.post(
  "/interns/:id/resend-welcome",
  requireLogin,
  requireRole("admin"),
  interns.resendWelcome,
);
router.post(
  "/interns/:id/terminate",
  requireLogin,
  requireRole("admin"),
  interns.terminate,
);

module.exports = router;
