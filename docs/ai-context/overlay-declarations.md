# What the shared rules ask DojoOS

The handbook's rules dereference six answers from this file. Both
`CLAUDE.md` and `AGENTS.md` route here; nothing else holds these answers.

## Sensitive subsystems

Beyond the universal entries (migrations, auth, payments):

- **Auth and sessions** — the magic-link sign-in, sessions, the tier check.
  Every route depends on it and nothing in DojoOS is public.
- **Storage access** — the S3 client, presigned upload and download URLs.
  A mistake here makes Jared's private footage reachable.
- **The job queue and the worker's scheduling** — a timer that touches the
  database bills compute by the hour (see `decisions.md`); a change here is
  weighed on cost as well as correctness.

## API-validation schemas

Generated from the OpenAPI spec by Orval: the `api-spec` package produces
the Zod schemas and React hooks used by the web package. A change to the
spec regenerates both; the generated files are never hand-edited.

## Async-status reference implementation

The library page's per-source ingest state (uploading, uploaded, probing,
proxying, transcribing, ready, failed with the error) is the reference. It
is minimal today and is the pattern later job surfaces copy.

## Shared modules a reviewer should know

- `lib/shared` — the Drizzle schema, the job queue (`enqueue`, `claim`,
  `complete`, `fail`), the storage client, the resolved-EDL types and
  resolver, the command taxonomy.
- `artifacts/worker/src/runner.ts` — the drain runner; every worker job
  goes through it.
- `scripts/run-production.mjs` — the supervisor; the deployment's one
  production command.

## Feature phases

Regime: **`main`** — nothing is downstream of `main` (no learners, no
published app), so prototype-phase features live on `main` and their PRs
merge on green CI. The prototype environment is the Repl's development
workspace, which tracks `main`.

| Feature | Phase | Since | Regime | Prototype directory |
|---|---|---|---|---|

No feature is registered yet. The scaffold is the repository's machinery,
not a product feature. **Each feature is added here by its own one-line PR
before its first version's planning loop opens**; the logging viewer with
live preview is the first.

## Tester tier

- **Tier:** `tester` in the `users.tier` enum.
- **Setting that switches it on:** `TESTER_EMAIL` — the account named
  there is provisioned at web boot with the tester tier, and the feedback
  rail renders only for that tier.
- **Members:** David (tester) and Jared (operator; the rail is offered to
  him through the tester account when David asks).
- **CI `push` trigger on `prototype/**`:** not declared. DojoOS is in the
  `main` regime; the trigger is added before the first branch-regime
  prototype, if one is ever needed.
