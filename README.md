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

Run the web process through the configured `artifacts/web: web` workflow, or with `PORT=22333 BASE_PATH=/ pnpm --filter @workspace/web dev`. Build it with `PORT=22333 BASE_PATH=/ pnpm --filter @workspace/web build`, then run `PORT=22333 BASE_PATH=/ pnpm --filter @workspace/web serve`. Run the worker with `pnpm --filter @workspace/worker dev` (or `start`); it needs `ffprobe` and `ffmpeg` on `PATH`. The worker has no port or health endpoint. Verify with `pnpm run typecheck` and `pnpm --filter @workspace/web lint`.

No sample shoots, media, questions or feedback are seeded. At web boot only the configured operator and tester are provisioned; previously configured addresses are disabled without deletion. Add question records directly to the `questions` table when ready to collect tester answers; there is no question-admin page in this first build.

## Deployment

The web artifact has a production Express run command and must be published as an always-on **Reserved VM**, not a static or autoscale deployment. Keep `APP_ORIGIN` equal to that deployment's HTTPS origin and provide all web variables in production. Restrict deployment visibility as appropriate; the app itself requires a session for data routes and protected pages.

The worker should run continuously as a **background worker Reserved VM** from a **second Repl checked out from the same repository**, using `pnpm install` to build, and `pnpm --filter @workspace/worker start` to run. Both processes must reach the **same production Postgres database** and private S3 bucket. Do not point the second Repl at its own automatically provisioned database. Replit's project-scoped managed database is not automatically shared between Repls; arrange a securely shared connection before deploying the worker. This limitation is intentionally not hidden by launching an in-process worker in the web server.

The only unauthenticated API operations are the magic-link request and single-use verification needed to establish a session. All other product API operations require a cookie session. The sign-in page and its static assets must be reachable before authentication; media files are never public and are only accessible using expiring signed GET URLs.