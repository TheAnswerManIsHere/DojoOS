# Deferred work — DojoOS

Items deliberately left for later, each with where it came from. The
maintenance pass reads and updates this list.

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
- **`lib/db` is an unused template package** whose `push` and `push-force`
  scripts point drizzle-kit at the live database with an empty schema.
  Denied in `.claude/settings.json` and forbidden in `replit.md`; removed
  by its own bugfix PR. (Enrollment, 2026-10-03.)
- **`.mcp.json` declares no servers** — Firecrawl is added when DojoOS
  first needs web research beyond `WebFetch`.
