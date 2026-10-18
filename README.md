# MIST Intern Task App

A web app for supervisors to manage interns and tasks, and for interns to submit work and view feedback and task history. It uses Express, Pug templates, MongoDB/Mongoose, and plain browser JavaScript and CSS.

## What it does

- Supervisors create intern accounts, assign tasks, review submissions, leave feedback, request resubmissions, and manage internship dates.
- Interns view assigned tasks, submit work, and see feedback and their history.
- The app supports uploaded task files, task search and filtering, an audit log, and downloadable history/archive reports.
- Scheduled jobs send task reminders and summaries and deactivate interns whose placements have ended.

## Requirements

- Node.js and npm, using versions compatible with the dependencies in `package.json`.
- A MongoDB database.

## Run locally

1. Install dependencies:

   ```bash
   npm ci
   ```

2. Create a `.env` file in the project root. Example values for local development:

   ```dotenv
   DATABASE=mongodb://127.0.0.1:27017/mist-intern-task-app
   SESSION_SECRET=replace-this-with-a-long-random-secret
   APP_URL=http://localhost:3000
   APP_TIMEZONE=Africa/Lagos
   PORT=3000
   ```

   `.env` is ignored by Git. Do not commit real credentials or secrets.

3. Start the app:

   ```bash
   npm start
   ```

   Open `http://localhost:3000`. The server needs a working MongoDB connection before it starts.

4. Create the first supervisor account in another terminal:

   ```bash
   node scripts/createAdmin.js "Supervisor Name" supervisor@example.com
   ```

   The script prompts for the password without displaying it.

For development with automatic server restarts, use `npm run dev`.

## Environment variables

| Variable | Required? | Purpose |
|---|---|---|
| `DATABASE` | Yes | MongoDB connection string for the app and account-management scripts. |
| `SESSION_SECRET` | Yes in production | Secret used to sign login sessions. Use a long, random value. |
| `APP_URL` | Yes in production | Public HTTPS address used to create links in emails. |
| `NODE_ENV` | Set to `production` for deployment | Enables production security settings. |
| `PORT` | Usually supplied by the host | Port for the web server; defaults to `3000`. |
| `APP_TIMEZONE` | No | Time zone for date calculations and scheduled jobs; defaults to `Africa/Lagos`. |
| `BREVO_API_KEY` | No | Brevo API key for sending email. Without it, email is logged instead of sent. |
| `BREVO_SENDER_EMAIL` | No | Verified sender address for Brevo. Email sending also requires `BREVO_API_KEY`. |
| `BREVO_SENDER_NAME` | No | Optional display name for outgoing email. |
| `CRON_SECRET` | Only for an external scheduler | Shared secret required by the external daily and weekly job endpoints. |
| `DATABASE_LOCAL` | Only for demo seeding | Local-only database URI used by `scripts/seedDemo.js`; the script refuses to seed using `DATABASE`. |

## Tests

Run the full Jest test suite:

```bash
npm test
```

The tests use an in-memory MongoDB and do not need the production database.

## Deploy to Render

1. Push the project to a GitHub repository.
2. In Render, create a **Web Service** and connect the repository and branch you want to deploy. Render's [Express deployment guide](https://render.com/docs/deploy-node-express-app) describes this flow.
3. Use these service settings:

   | Setting | Value |
   |---|---|
   | Runtime | Node |
   | Root Directory | Leave blank if this repository itself is the app folder; otherwise set it to the app's folder within the repository. |
   | Build Command | `npm ci --omit=dev` |
   | Start Command | `npm start` |
   | Health Check Path | `/healthz` |

4. Add these environment variables in the Render service's **Environment** settings:

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE` | Your production MongoDB connection string. |
   | `SESSION_SECRET` | A long, randomly generated secret. |
   | `APP_URL` | The service's public `https://...onrender.com` URL, or your custom HTTPS domain. |
   | `APP_TIMEZONE` | `Africa/Lagos`, or the time zone your organization uses. |
   | `BREVO_API_KEY` | Optional; add this and `BREVO_SENDER_EMAIL` to send real email. |
   | `BREVO_SENDER_EMAIL` | Optional; a verified sender address in Brevo. |
   | `BREVO_SENDER_NAME` | Optional; the name recipients see as the sender. |
   | `CRON_SECRET` | Optional; set this only if an external scheduler will call the cron endpoints. |

   Render supplies `PORT` automatically; the app listens on that port. Do not commit these values to GitHub. The app checks that `NODE_ENV` is `production` on Render and requires a public HTTPS `APP_URL`.

5. Deploy the service and check its logs for a successful MongoDB connection. Visit `https://<your-service>.onrender.com/healthz`; a healthy response reports `{"status":"ok","db":"connected"}`. Render supports configuring a [health check path](https://render.com/docs/health-checks) for a web service.

6. Create the first supervisor account against the production database only after checking that `DATABASE` points to the intended database:

   ```bash
   node scripts/createAdmin.js "Supervisor Name" supervisor@example.com
   ```

   Run this from a local terminal with the production `DATABASE` value set securely, or use a secure one-off shell supported by your deployment workflow. The script prompts for the password without displaying it.

### Email and scheduled jobs on Render

- Without `BREVO_API_KEY` and `BREVO_SENDER_EMAIL`, email is logged instead of delivered. Configure a verified sender in Brevo for real delivery.
- The app's in-process scheduler runs while the web service is awake. If your service may sleep, use Render Cron Jobs or another external scheduler to call `POST /api/cron/daily` and `POST /api/cron/weekly`. Send the `CRON_SECRET` value in the `x-cron-secret` header. Render's [Cron Jobs documentation](https://render.com/docs/cronjobs) explains setting up scheduled jobs.
- The `/healthz` endpoint reports whether the app can reach MongoDB.

## Administrative scripts

Run scripts from the project root with the appropriate environment variables set.

| Command | Purpose |
|---|---|
| `node scripts/backup.js` | Saves database collections and uploaded files under `backups/`. Backups contain sensitive personal data and password hashes; keep them private. |
| `node scripts/restore.js backups/<backup-folder>` | Restores collections from a backup after confirmation. This replaces data in collections contained in that backup. |
| `node scripts/resetDatabase.js` | Permanently deletes all data in the configured database after you type its name. |
| `node scripts/setPassword.js person@example.com` | Sets a new password for an existing account and ends that account's active sessions. |
| `node scripts/handOver.js old@example.com new@example.com` | Transfers a supervisor's interns, tasks, and audit history to another supervisor after confirmation. |
| `node scripts/deleteUser.js person@example.com` | Permanently deletes an intern or supervisor after confirmation. Back up first. |
| `node scripts/seedDemo.js supervisor@example.com` | Adds demo data to the database selected by `DATABASE_LOCAL`. Use only with a local database. |
| `node scripts/seedDemo.js supervisor@example.com --remove` | Removes demo data created by the demo seeding script. |

`deleteUser.js` and `handOver.js` accept `--yes` to skip their interactive confirmation. Use that option only when you have verified the target database and intended action. `resetDatabase.js` and `restore.js` require interactive confirmation.
