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
  exits non-zero if either dies. Dedicated 2 vCPU / 8 GiB RAM, *"$50 per
  month ($0.0694/hour)"*, region North America (David's screenshot,
  2026-10-29). The one startup those screenshots captured (deployment
  `3ff15af5`, 2026-10-29 02:52 UTC) logged five *"healthcheck failed
  error=healthcheck / returned status 500"* lines before *"DojoOS web
  listening on 22333"*, and the publish still promoted. The web process logs
  that line only after it listens, so something other than the app answered
  `/` in those seconds; whether it happens on every boot, and how slow a boot
  would have to be to fail a publish's health check, were not measured. The
  same startup logged the `pg` driver's warning that *"The SSL modes 'prefer',
  'require', and 'verify-ca' are treated as aliases for 'verify-full'"* and
  that *"In the next major version (pg-connection-string v3.0.0 and pg
  v9.0.0), these modes will adopt standard libpq semantics, which have weaker
  security guarantees"* — a dependency upgrade to read before taking, not a
  fault today.
  Published at `https://dojo-os.replit.app`
  (`get_publish_status`, 2026-10-29: `"status":"success"`, deployment
  `0abb77c7-26ee-41e5-8c5a-ce85897e56b5`); an earlier line here said not yet
  published. Being published changes nothing about who publishes: a
  republish is still David's word only (`claude-core.md`, *Connectors →
  Replit*). The development
  workspace's run command is the same supervisor with `--dev` (the web
  server's dev script), so the worker runs there too; until 2026-10-23 it
  ran the web server alone and queued ingest waited for a hand-started worker.
  Both commands run from `artifacts/web` (measured for development, when
  #33's root-relative path failed with `MODULE_NOT_FOUND`); the production
  command finds the supervisor from either the root or `artifacts/web`,
  since its working directory is not yet measured. Hand-run worker commands
  stage under `<repo>/tmp` when it exists (`artifacts/worker/src/scratch.ts`).
- **Nix packages:** `ffmpeg` 7.1.1 (with `ffprobe`) and `libreoffice`
  24.8.7.2, declared in `.replit`.
- **Secrets** (the Replit Secrets pane; never committed): `SESSION_SECRET`,
  `OPERATOR_EMAIL`, `TESTER_EMAIL`, `JARED_PASSWORD`, `DAVID_PASSWORD`,
  `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, and the transcription keys `ELEVENLABS_API_KEY` and
  `ASSEMBLYAI_API_KEY` (`architecture.md`, *Transcription*). The full list
  with defaults is in `README.md`. All of these appear in the deployment's
  *Production app secrets* synced from the workspace (David's screenshot,
  2026-10-29), so changing one in the workspace changes production at the
  next publish unless that secret is unsynced there.
- **Disk:** the workspace volume is 256 GB; the development workspace's
  `/tmp` is a 4 GB RAM disk (`tmpfs`, measured 2026-10-23; an earlier note
  here said 32 GB), which a 3 GB original and its proxy overflowed with
  `ENOSPC`. So in development the supervisor points the worker's `TMPDIR`
  at `<repo>/tmp` on the workspace volume (gitignored). Hand-run commands
  (`import.ts`, `pilot.ts`) find that folder themselves. The deployment's writable disk is
  measured at scaffold step 0.
- **Sync after a merge:** Claude asks Replit to pull `main` and report the
  checked-out SHA and a clean tree. Every change to `main` arrives through a
  pull request, David's display-only tweaks from Replit included: a tweak
  committed on the Repl's `main` is moved to a branch and opened as a PR,
  never pushed to `main` directly (`claude-core.md`, *This environment's git
  constraints*; the record is
  `.agents/memory/replit-commits-reach-main-only-through-a-pr.md`).
- **`[postMerge]`** (`scripts/post-merge.sh`, `pnpm install
  --frozen-lockfile`) is run by the Agent after it merges one of its own
  tasks — not after a workspace `git pull` and not at publish (Replit
  Agent's account, 2026-10-29, unconfirmed by Replit's docs). So it does not
  install dependencies after the close-out sync; that sync's request still
  has to.
- **How the platform works** — what a publish takes, the publish-time
  production schema step, secrets, rollback, Agent modes, the connector's
  60-second timeout — is the fleet's
  `replit-platform.md` (beside this file once the handbook sync that ships it lands); this file carries only what is
  true of this Repl.
- **Replit Agent's own notes** are `replit.md`, which routes it here.
- **Connector gotcha:** the Replit file-listing and file-reading tools do
  not show `*.sql` files; ask the Agent to run `git ls-files` instead.
