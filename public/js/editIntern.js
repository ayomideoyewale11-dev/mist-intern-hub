document
  .getElementById("edit-intern-form")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = document.getElementById("edit-intern-status");
    status.removeAttribute("data-state");
    status.textContent = "Saving…";
    try {
      await api(`/api/auth/interns/${form.dataset.internId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: document.getElementById("editInternName").value,
          email: document.getElementById("editInternEmail").value,
          internshipStartDate: document.getElementById("editInternStart").value,
          internshipEndDate: document.getElementById("editInternEnd").value,
          active: document.getElementById("editInternActive").checked,
        }),
      });
      uiFlash("Changes saved.");
      window.location.href = document.getElementById("editInternActive").checked
        ? "/interns"
        : "/alumni";
    } catch (err) {
      status.textContent = err.message;
      status.dataset.state = "error";
    }
  });

document
  .getElementById("resend-welcome-btn")
  ?.addEventListener("click", async (e) => {
    const status = document.getElementById("resend-status");
    status.removeAttribute("data-state");
    status.textContent = "Sending…";
    try {
      await api(
        `/api/auth/interns/${e.target.dataset.internId}/resend-welcome`,
        { method: "POST" },
      );
      status.textContent = "Welcome email sent.";
      status.dataset.state = "ok";
    } catch (err) {
      status.textContent = err.message;
      status.dataset.state = "error";
    }
  });

// Moving an ended intern's end date into the future restores them: tick the
// Active box for the supervisor (the server refuses "active" with a past date).
document.getElementById("editInternEnd")?.addEventListener("change", (e) => {
  // A terminated intern is only ever restored on purpose, by ticking Active themselves
  if (document.getElementById("edit-intern-form").dataset.terminated === "true")
    return;
  const today = document.querySelector('meta[name="app-date"]').content;
  if (e.target.value && e.target.value >= today) {
    document.getElementById("editInternActive").checked = true;
  }
});

// Terminate: needs a reason, then a clear confirmation before anything happens.
document
  .getElementById("terminate-form")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const status = document.getElementById("terminate-status");
    const reason = document.getElementById("terminateReason").value.trim();
    status.removeAttribute("data-state");
    if (!reason) {
      status.textContent = "Please write the reason first.";
      status.dataset.state = "error";
      return;
    }
    const ok = await uiConfirm(
      `${form.dataset.internName} will be emailed your reason, logged out straight away and will not be able to log in again. Their tasks will no longer show on your Dashboard or Archive, but nothing is deleted. You can undo this later.`,
      {
        title: "Terminate this internship?",
        confirmText: "Terminate",
        danger: true,
      },
    );
    if (!ok) return;
    status.textContent = "Ending the internship…";
    try {
      await api(`/api/auth/interns/${form.dataset.internId}/terminate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      uiFlash("Internship terminated.");
      window.location.href = "/alumni";
    } catch (err) {
      status.textContent = err.message;
      status.dataset.state = "error";
    }
  });
