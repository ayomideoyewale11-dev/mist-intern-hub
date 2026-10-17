const express = require("express");
const router = express.Router();
const { requireLogin, requireRole } = require("../middleware/authGuards");
const { handleUpload } = require("../middleware/upload");
const tasks = require("../controllers/taskController");
const submissions = require("../controllers/submissionController");

router.use(requireLogin); // every task route needs a logged-in user

// Supervisor
router.get("/archived", requireRole("admin"), tasks.archived);
router.get("/interns", requireRole("admin"), tasks.internsForPicker);
router.post("/", requireRole("admin"), tasks.create);
router.put("/batch/:batchId", requireRole("admin"), tasks.extendBatch); // before /:id
router.put("/:id", requireRole("admin"), tasks.update);
router.delete("/:id", requireRole("admin"), tasks.remove);
router.post("/:id/feedback", requireRole("admin"), tasks.feedback);
router.post("/:id/reopen", requireRole("admin"), tasks.reopen);

// Intern
router.post(
  "/:id/submission",
  requireRole("intern"),
  handleUpload,
  submissions.submit,
);

// Both roles (the controller checks the task belongs to them)
router.get("/", tasks.list);
router.get("/:id/submission/file", submissions.downloadSubmission);
router.get("/:id/earlier/:n/file", submissions.downloadEarlier);

module.exports = router;
