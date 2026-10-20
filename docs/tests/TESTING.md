# Testing — DojoOS

| What | Command | Where |
|---|---|---|
| Typecheck, every package | `pnpm run typecheck` | CI and locally |
| Web lint, including the module-boundary rule | `pnpm --filter @workspace/web lint` | CI and locally |
| Worker lease-expiry, renewal and reclaim tests, and the ingest media tests (proxy, sprite, peaks from generated clips) | `pnpm --filter @workspace/worker test` | CI and locally; needs `DATABASE_URL` pointing at a migrated database (CI's Postgres service, migrated by `pnpm --filter @workspace/shared run migrate`), and `ffmpeg` and `ffprobe` on PATH (CI installs them; the Repl has them from `replit.nix`); the media tests fail rather than skip without them |
| Journeys: the real web server over HTTP, and Chromium walks of sign-in, the tester's feedback rail, the operator's feedback page and proxy playback through a signed URL | `pnpm --filter @workspace/web test:journeys` | CI and locally; needs a migrated `DATABASE_URL` whose database is named `test` or ends in `_test` (the journeys reseed the operator and tester accounts and refuse any other name), and `playwright install chromium` once |
| Handbook machinery tests | `node --test scripts/__tests__/*.test.mjs` | CI and locally |
| Docs accuracy | `node scripts/check-docs-accuracy.mjs` | not in CI yet: it fails on synced handbook files that cite other products' paths (see `docs/engineering/deferred-work.md`) |
| UAT document format | `node scripts/check-uat-format.mjs` | CI |

Prototype-phase features carry no code-review loop and no hardening bar
until David flips them to production, but they keep the machine lanes
(`ci`, `scripted`, `live`) scaled to a prototype as the proof that a version
works before the owner is asked — the handbook's `working-modes.md`, *What
prototype phase keeps of verification*. The pure functions at the centre (`resolveCut`,
`clipRevision`, `applyCommand`) get unit tests when they are first
implemented, because every feature depends on them.
