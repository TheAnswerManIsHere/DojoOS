# DojoOS — scaffold reconciliation, step 0

## 1. Worker: nudge-driven drains, leases, and retry cap

Removed the two-second empty-queue polling loops and the five-second error-retry sleep.
The worker now:

- Inspects existing claimed leases once at startup, then starts a drain pass.
- Claims work to fill available execution slots and continues draining as jobs finish.
- Listens only on `127.0.0.1` for `POST /nudge`. It is not registered as a public artifact service.
- Returns to idle without any lease timer when no job is held or observed as claimed. The only idle safety timer is six hours.
- Schedules one claim attempt at each held or startup-observed row's lease expiry. Lease cancellation does not add a second claim attempt.
- Cancels an expired local execution before its replacement executes. Ownership is unique per claim, so an old execution cannot acknowledge a newer claim.
- Does not run an automatic short retry timer after database errors; it waits for a nudge, an outstanding lease expiry, or the safety timer.

Web's queue wrapper initiates a localhost nudge immediately after every successful enqueue. The request does not await delivery. There is one initial attempt plus three retries with 250/500/1000 ms backoff; final failure is logged. The upload handlers and storage client were not edited.

Configuration:

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKER_NUDGE_PORT` | `4711` | Localhost port shared by web and worker |
| `WORKER_SAFETY_POLL_MS` | `21600000` | Safety-drain interval; values shorter than six hours are rejected |
| `JOB_LEASE_MS` | `1800000` | Queue lease, shared by web and worker |
| `WORKER_CONCURRENCY` | `2` | Maximum simultaneous executing jobs, not polling loops |

Lease and safety durations must be positive, timer-safe integers (at most 2147483647 ms); safety must also be at least six hours.

The queue still has the same four operations and signatures: `enqueue`, `claim`, `complete`, and `fail`. Job states are unchanged. Expired/queued work at attempt count three is marked failed instead of reclaimed; its stored last error is retained. No fourth claim is allowed.

Focused tests passed for empty-drain inactivity, nudge-triggered draining, a single observed-lease attempt, concurrency bounds, and a held lease's single expiry attempt. A real development-database test passed for third-attempt reclamation and subsequent failure with the last error retained. That test ran inside a rolled-back transaction; it left no test jobs.

**Not verified:** the complete worker's startup drain and two minutes of actual database inactivity, because the worker cannot start without its real S3 configuration. See section 8. Short isolated scheduler tests are not a substitute for that measurement.

## 2. Schema: one Drizzle migration

Generated and applied exactly one new migration: `lib/shared/drizzle/0001_sweet_jack_power.sql`.

- Added `render` and `deck` to `source_role`.
- Added nullable `sources.origin_revision`, referencing `revisions.id`.
- Renamed `revisions.edl` to `resolved_edl`; it remains non-null jsonb. The migration uses `RENAME COLUMN`, not drop-and-create.
- Added `slides`, with source reference, index, image key, nullable title/notes, and audit columns.
- Added `cut_slides`, with cut/slide references, position, brick/time anchors, and audit columns.
- Added `cut_events`, with command, actor, sequence, and creation timestamp only. It has no update/soft-delete columns and has a unique index on `(cut_id, sequence)`.
- Added `cuts.mode`, using the new `cut_mode` enum (`camera`, `deck`), non-null with default `camera`.
- Added optional `placement` to the TypeScript type of `cut_bricks.overrides`.
- Added relations for the new tables and the revision/source provenance link.

Migration output:

```text
Using 'pg' driver for database querying
[✓] migrations applied successfully!
```

The migration was applied to the workspace development database, not production. No product records were seeded.

## 3. Shared types: stubs only

Added and exported `lib/shared/src/edl.ts` with the requested `ResolvedEDL` shape and `resolveCut` / `clipRevision` signatures. Both throw `Error("not implemented")`.

Added and exported `lib/shared/src/commands.ts`. `Command` is the empty union (`never`), awaiting future discriminated members; `applyCommand` throws `Error("not implemented")`.

No runtime production code calls these stubs. No editing or rendering behavior was added.

## 4. Environment: LibreOffice and media tools

Installed the Nix packages `libreoffice` and `ffmpeg`. They are persisted in `.replit` under `[nix].packages` for the workspace and publishing configuration. `ffprobe` remains available through ffmpeg.

Workspace version output:

```text
LibreOffice 24.8.7.2 480(Build:2)
ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers
ffprobe version 7.1.1 Copyright (c) 2007-2025 the FFmpeg developers
```

A headless text-to-PDF conversion using an isolated temporary profile succeeded:

```text
convert .../check.txt as a Writer document -> .../check.pdf using filter : writer_pdf_Export
HEADLESS_PDF_OK
```

LibreOffice emitted Java-runtime and OpenCL warnings; they did not prevent that conversion. The temporary fixture/profile/PDF were removed. No slide/deck conversion feature was added.

**Not verified:** the binaries in a published deployment, since nothing was published during this work.

## 5. Module boundary

The existing web ESLint configuration already has a `no-restricted-imports` rule requiring public module-index access.

Added temporary `auth/internal-boundary-check.ts` and a deliberate import from `library/boundary-check.ts`, ran lint, and received:

```text
/home/runner/workspace/artifacts/web/server/modules/library/boundary-check.ts
  1:1  error  '../auth/internal-boundary-check' import is restricted from being used by a pattern. Import another module only through its public index  no-restricted-imports

✖ 1 problem (1 error, 0 warnings)
```

Lint exited 1. Removed both temporary files. Normal web lint subsequently passed, exit 0. No boundary-test files remain.

## 6. Development sign-in

For an allowed account, when `NODE_ENV !== "production"` and `SMTP_URL` is absent, the existing request endpoint returns a development-only magic link instead of sending mail. The existing sign-in page displays the link. Unknown addresses do not receive links.

Production does not return that development response, and the client only accepts an on-screen link in a development build. Production bootstrap rejects missing SMTP before opening the web port.

Verified startup failure without SMTP:

```text
Error: SMTP_URL is required in production
Exit status 1
PRODUCTION_WITHOUT_SMTP_EXIT=1
```

Updated the sign-in response contract and regenerated the API client. No new page, public product route, account, or styling was added.

**Not verified:** requesting and consuming the development link in a running app. The configured account addresses and S3 configuration are still absent, so the existing application cannot boot.

## 7. Secrets

I cannot generate and store a secret through the available secure tools. Those tools expose secret existence and a user-entry form, but no programmatic secret-writing operation.

`SESSION_SECRET` already exists. I did not read its value, replace it, or claim that it is a newly generated 32-byte key. No placeholder was added. No other secret was created.

## 8. Workspace measurements and execution results

The worker still uses Node's `os.tmpdir()`, which resolves to `/tmp`, for its temporary originals. The existing download-to-local-file behavior remains; it was not replaced with HTTPS probing.

`df -h . /tmp`:

```text
Filesystem      Size  Used Avail Use% Mounted on
/dev/vdf        256G  846M  254G   1% /home/runner/workspace
/dev/vdb         32G   17M   32G   1% /tmp
```

Verification completed:

| Check | Actual result |
| --- | --- |
| `pnpm install` | Exit 0; lockfile up to date |
| Development migration | Exit 0; migrations applied successfully |
| `pnpm run typecheck` | Exit 0 |
| `pnpm --filter @workspace/web run lint` | Exit 0 after temporary violation removed |
| `PORT=22333 BASE_PATH=/ pnpm -r build` | Exit 0; web built and worker TypeScript check passed |
| Focused worker/queue tests | 5 passed, 0 failed |
| Production web without SMTP | Startup rejected, exit 1, as required |

The `PORT` and `BASE_PATH` prefix supplies the same values as the configured artifact service; the recursive build command is `pnpm -r build`.

Ran the real supervisor briefly with the workspace's current configuration. It started both package commands, but it did **not** bring both processes to a healthy state:

```text
> @workspace/worker@0.0.0 start /home/runner/workspace/artifacts/worker
> tsx src/index.ts

> @workspace/web@0.0.0 serve /home/runner/workspace/artifacts/web
> NODE_ENV=production tsx server/index.ts

Error: S3_ENDPOINT is required
worker exited unexpectedly (1); stopping the deployment
Command failed with signal "SIGTERM"

SUPERVISOR_EXIT=1
```

The worker died before reaching its startup-drain log. The supervisor correctly terminated the sibling and returned 1. Independent web startup also fails without production SMTP, as shown in section 6.

**Could not do as written:** confirm healthy simultaneous startup and then measure two minutes with no worker database activity. Real SMTP, the two account addresses, and private S3 configuration are missing. I did not create replacement secrets, fake configuration, demo accounts, or a storage fallback to bypass those blockers.

The development workflow restart also failed with `S3_ENDPOINT is required`; the sign-in preview could not be captured. A read-only check after testing found zero jobs, sources, revisions, slides, and cut events.