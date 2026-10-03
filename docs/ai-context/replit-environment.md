# DojoOS — the Replit environment

- **Repl:** `139f7df4-9dd7-4b41-9fde-144f007b92f2`, connected to
  `TheAnswerManIsHere/DojoOS` (David connected it 2026-10-03). The
  development workspace tracks `main`.
- **Database:** Replit's managed PostgreSQL. The workspace has its own
  development database; the published deployment has a separate production
  database. Migrations are Drizzle files in `lib/shared/drizzle`; the
  development database is migrated with the package's `migrate` script,
  and production schema changes are applied by Replit's publish flow.
- **Deployment:** one Reserved VM (2 vCPU / 8 GB), production command
  `node scripts/run-production.mjs`, which supervises web and worker and
  exits non-zero if either dies. Not yet published.
- **Nix packages:** `ffmpeg` 7.1.1 (with `ffprobe`) and `libreoffice`
  24.8.7.2, declared in `.replit`.
- **Secrets** (the Replit Secrets pane; never committed): `SESSION_SECRET`,
  `OPERATOR_EMAIL`, `TESTER_EMAIL`, `APP_ORIGIN`, `MAIL_FROM`, `SMTP_URL`,
  `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`. The full list with defaults is in `README.md`.
- **Disk:** the workspace volume is 256 GB; `/tmp`, where the worker
  currently stages files, is 32 GB. The deployment's writable disk is
  measured at scaffold step 0.
- **Sync after a merge:** Claude asks Replit to pull `main` and report the
  checked-out SHA and a clean tree. David may push display-only tweaks
  directly from Replit's Git pane; Claude sweeps those commits.
- **Replit Agent's own notes** are `replit.md`, which routes it here.
- **Connector gotcha:** the Replit file-listing and file-reading tools do
  not show `*.sql` files; ask the Agent to run `git ls-files` instead.
