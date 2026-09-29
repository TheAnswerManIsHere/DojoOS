# DojoOS

Private intake and feedback foundation for a physical therapist's video-production pipeline. The web process is an Express server with a Vite-built React SPA. The background worker has no HTTP listener. Both import `@workspace/shared` for schema, queue, storage and future EDL/template contracts.

## Setup

Node 20+ and pnpm are required. Install with `pnpm install`. The workspace already supplies `DATABASE_URL` for the development PostgreSQL database. Configure the remaining variables as Replit Secrets (never commit credentials):

| Variable | Used by | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | both, migrations | PostgreSQL connection (managed by Replit in this workspace) |
| `SESSION_SECRET` | web | 32+ character token signing key |
| `OPERATOR_EMAIL` | web | Exact allowed operator address |
| `TESTER_EMAIL` | web | Exact allowed tester address, different from operator |
| `APP_ORIGIN` | web | Public origin for emailed links, e.g. the *published* HTTPS origin (no path) |
| `MAIL_FROM` | web | Verified sender address |
| `SMTP_URL` | web | SMTP transport URL with credentials, entered as a secret |
| `S3_ENDPOINT` | both | S3-compatible HTTPS endpoint |
| `S3_REGION` | both | S3 region |
| `S3_BUCKET` | both | Private S3 bucket |
| `S3_ACCESS_KEY_ID` | both | S3 access key |
| `S3_SECRET_ACCESS_KEY` | both | S3 secret key |
| `WORKER_CONCURRENCY` | worker | Polling slots, integer 1–16 (default 2) |
| `BUILD_VERSION` | web | Optional value recorded with tester feedback (default `development`) |
| `PORT`, `BASE_PATH` | web | Injected by the Replit artifact workflow |

For Backblaze B2, use its S3-compatible endpoint and application key as generic S3 credentials. The bucket must be **private**. Configure bucket CORS to permit the web origin to `PUT`, allow `Content-Type`, and expose the `ETag` response header; otherwise direct multipart uploads cannot resume or complete. The browser sends chunks directly to the S3 endpoint. Parts use short-lived presigned URLs and require no proxy through Express. After an interrupted upload, select the same original file in Pending uploads to resume. Reopening the browser retains upload IDs and completed part ETags locally; the authoritative upload record is in Postgres.

Generate and apply development migrations with:

```sh
pnpm --filter @workspace/shared run migrate:generate
pnpm --filter @workspace/shared run migrate
```

The first migration is checked in. Do not regenerate it after it has been applied; for subsequent schema changes, generate a new migration. Production schema changes for Replit's managed database are applied by the Replit Publish flow, not by startup-time DDL.

Run the web process through the configured `artifacts/web: web` workflow, or with `PORT=22333 BASE_PATH=/ pnpm --filter @workspace/web dev`. Build it with `PORT=22333 BASE_PATH=/ pnpm --filter @workspace/web build`. The separate package run targets remain `pnpm --filter @workspace/web serve` and `pnpm --filter @workspace/worker start`; in development the worker can be run independently with `pnpm --filter @workspace/worker dev`. The worker needs `ffprobe` and `ffmpeg` on `PATH` and has no port or health endpoint. Verify with `pnpm run typecheck` and `pnpm --filter @workspace/web lint`.

No sample shoots, media, questions or feedback are seeded. At web boot only the configured operator and tester are provisioned; previously configured addresses are disabled without deletion. Add question records directly to the `questions` table when ready to collect tester answers; there is no question-admin page in this first build.

## Deployment

The current topology is **one Reserved VM deployment** with one production command, `node scripts/run-production.mjs`. The supervisor starts the web server and worker as separate child processes in the same deployment, forwards shutdown signals to both, and exits non-zero if either process ends unexpectedly. The web server owns the HTTP port; the worker has no listener. Both share the same deployment's database and S3 configuration. Keep `APP_ORIGIN` equal to the published HTTPS origin and provide all web and worker variables in production. Restrict deployment visibility as appropriate; the app itself requires a session for data routes and protected pages.

The web and worker packages retain independent development and start scripts so the worker can move to a separate Reserved VM in a second Repl later. Before making that split, arrange access to the **same production Postgres database** and private S3 bucket; a second Repl does not automatically inherit this project's managed database.

The only unauthenticated API operations are the magic-link request and single-use verification needed to establish a session. All other product API operations require a cookie session. The sign-in page and its static assets must be reachable before authentication; media files are never public and are only accessible using expiring signed GET URLs.