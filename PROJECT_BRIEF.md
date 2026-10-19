# Project Brief: MIST Intern Task App

## 1. Objective

The MIST Intern Task App is a school project: a supervisor-managed internship tracker. It gives instructors (admins) a single place to create intern accounts, assign work, review submissions, and keep a record of what happened. Interns use it to see assigned tasks, submit work, and read feedback.

The product goal is not a public marketplace or self-serve classroom. Supervisors own the internships they create. There is no public intern registration. Each intern belongs to one supervisor, and that supervisor only sees their own interns, tasks, and audit history.

The app also covers the lifecycle around the work itself: placement dates, automatic deactivation when an internship ends, alumni records, email reminders, and downloadable history. Task files and past submissions are kept, including work that was sent back for resubmission.

## 2. Users and primary flows

### Supervisor (role: `admin`)

- Create intern accounts with internship start and end dates.
- Assign tasks to one intern or to a batch of interns.
- Search and filter tasks, extend due dates (including a whole batch), and delete open tasks.
- Review submissions, leave feedback, and request a resubmission without deleting earlier work.
- View intern history, alumni, and an audit log.
- Export intern history, the archive, and the audit log (PDF / CSV).
- Terminate or restore a placement, resend welcome mail, and change account details.

### Intern (role: `intern`)

- Log in, view assigned tasks, and open a task detail page.
- Submit a link, a note, and/or an uploaded file.
- Read supervisor feedback and previous submission rounds.
- View and export personal task history.
- Recover a forgotten password.

Ended or terminated internships remain in the supervisor’s alumni view. The intern can no longer log in, but the account and task history are not deleted.

## 3. Technical approach

The stack is a conventional server-rendered Node application:

| Layer | Choice |
|---|---|
| Runtime | Node.js |
| Web framework | Express 5 |
| Templates | Pug |
| Client | Plain JavaScript and CSS in `public/` |
| Database | MongoDB with Mongoose |
| Sessions | `express-session` stored in MongoDB via `connect-mongo` |
| Auth secrets | bcrypt password hashes |
| Files | Multer + MongoDB GridFS |
| Email | Brevo HTTP API (`config/mailer.js`) |
| Jobs | `node-cron` in-process, plus optional external cron HTTP endpoints |
| Tests | Jest, Supertest, in-memory MongoDB |

Pages are rendered on the server. Browser scripts call JSON APIs under `/api` for login, intern management, and task actions. That split keeps forms and lists in Pug while still supporting interactive list tools, uploads, and status updates without a SPA framework.

## 4. Architecture

Startup (`server.js`) loads environment config, sets `APP_TIMEZONE` (default `Africa/Lagos`) so due dates and cron jobs are not tied to the host clock, then connects to MongoDB. The Express app is created only after that connection exists so the session store can reuse it.

Request flow:

1. `/healthz` reports process and database readiness (used by hosts such as Render).
2. Helmet, body parsing, and a guard that rejects MongoDB operator keys in JSON bodies.
3. Cookie-based sessions (idle timeout, rolling, `httpOnly`).
4. CSRF token cookie plus header check on mutating API routes.
5. View routes (`/admin`, `/intern`, `/tasks/:id`, …) guarded by login/role middleware.
6. API routes (`/api/auth`, `/api/tasks`, `/api/suggest`, `/api/cron`).
7. Rate limits on auth and task APIs, stored in MongoDB so they survive process restarts.

Role checks exist twice: JSON errors for APIs, redirects for pages. Session validity is re-checked against the user record so a deactivated intern, ended placement, or deleted account cannot keep using an old cookie.

## 5. Data model concepts

### User

One collection serves both roles. Interns have a `supervisor` reference, placement dates, `active`, and optional termination fields. Supervisors do not. Password-reset tokens are stored only as SHA-256 hashes with an expiry.

### Task

A task belongs to one intern (`assignedTo`) and one supervisor (`createdBy`). Status is derived, not stored: **open**, **submitted**, or **overdue**, based on `submission.submittedAt` and whether the due date has passed in the app timezone.

Submission data (link, note, GridFS file, feedback) lives on the task. When a supervisor requests a resubmission, the current submission is moved into `previousSubmissions` and the intern gets a fresh empty submission. Batch assignment shares a `batchId` so due dates can be extended together.

### Audit log

Actions such as create, edit, submit, feedback, reopen, intern registration, and termination are written as denormalized events (names stored with IDs) so the log still reads after a task is deleted or a name changes.

## 6. Domain concepts the code is teaching

- **Role-based access control.** Supervisors and interns hit different pages and APIs. Data queries always scope to the logged-in supervisor or intern.
- **Derived workflow state.** Task status is computed from dates and submissions so there is one source of truth.
- **Placement lifecycle.** Daily jobs deactivate interns whose end date has passed, send ending reminders, and leave alumni records intact.
- **File uploads as first-class data.** Files go to GridFS, not the public folder. Type is checked from file bytes, not only the extension. Size is capped.
- **Idempotent reminders.** Flags such as `remindedDueSoon` and `remindedOverdue` prevent daily email spam. Failed sends can be retried.
- **Server-side sessions, not JWTs in localStorage.** Sessions live in MongoDB; cookies are session cookies with an idle timeout.
- **Defense in depth.** Helmet CSP, CSRF double-submit cookie, bcrypt, rate limits (IP and account), no-store on private pages, operator-key rejection, production checks for `SESSION_SECRET` and HTTPS `APP_URL`.
- **Operational extras.** Health check, backup/restore scripts, supervisor handover, demo seeding against a local-only database URI, PDF/CSV exports.

## 7. Email and scheduling

Email is optional. Without Brevo credentials, messages are logged and the main action (create intern, submit, feedback) still succeeds.

The in-process scheduler sends due-soon and overdue reminders, weekly supervisor summaries, ending-soon notices, and intern deactivation. If the web process can sleep (typical of free hosts), an external scheduler can call `POST /api/cron/daily` and `POST /api/cron/weekly` with `x-cron-secret`.

## 8. Out of scope

- Interns cannot create their own accounts or see other interns’ work.
- Supervisors cannot see another supervisor’s interns unless a handover script is run.
- There is no real-time chat or in-app notification channel beyond email and the pages themselves.
- Email delivery is not guaranteed in development or on a host without Brevo configured.

## 9. Success criteria

The project succeeds if a supervisor can run a placement end to end: register an intern, assign and review work (including files and resubmission), see history and audit records, and have dates, reminders, and alumni status behave correctly after the internship ends — with intern access limited to their own tasks and with the security controls above in place.
