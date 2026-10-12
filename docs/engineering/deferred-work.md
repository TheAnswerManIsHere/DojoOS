# Deferred work — DojoOS

Items deliberately left for later, each with where it came from. The
maintenance pass reads and updates this list.

Last maintenance pass: 2026-10-12 (first pass; the unused template
database package entry is closed, removed by #4).

- **Worker temp directory is `/tmp` (32 GB in the workspace)** — below one
  worst-case 4K original. Move staging to the large volume or read
  originals over signed range requests; decided by the deployment disk
  measurement at scaffold step 0. (Reconcile report, 2026-10-03.)
- **Bucket CORS for browser-direct multipart** — set once B2 credentials
  exist; whether it can be set over the S3 API or needs B2's web UI is
  settled then.
- **Mail provider for magic links** — chosen under the comparison rule
  before the first deployment.
- **Transcription, speech-to-text and the command classifier** — providers
  chosen in the build (architecture, *Media pipeline* and *commands*).
- **Docs-accuracy check out of CI** — its path rule fails on 31 citations
  in synced handbook files (examples from another product), none in
  DojoOS's own docs. Restored to CI once the handbook exempts synced files
  from the path rule. (Enrollment, 2026-10-03.)
- **nodemailer 7 → 10 (Dependabot #2), held** — a major bump across
  three majors that also adds a `prepare` install script; the PR's base is
  from before CI existed, so no check has ever run on it. Only the auth
  module's magic-link mail imports it. Revisit when the mail provider for
  magic links is chosen (above): merge then if that provider still uses
  nodemailer, after a rebase so CI runs, or close it if not.
  (Maintenance, 2026-10-12.)
- **`.mcp.json` declares no servers** — Firecrawl is added when DojoOS
  first needs web research beyond `WebFetch`.
