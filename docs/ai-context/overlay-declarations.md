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
| Ingest (step 1: proxy, sprite, peaks, playback; transcription and deck ingest to come) | prototype | 2026-10-20 | `main` | none — built in production phase before the declaration (#15), in `artifacts/worker/src/{ingest,media}.ts` and `lib/shared/src/media.ts`; ledger: #16; questions file written with its next version |
| Logging viewer with live preview (step 2) | prototype | 2026-10-23 | `main` | `artifacts/web/src/prototypes/logging-viewer/` (with its `questions.json` and ledger), written with its first version |
| Brick timeline and lesson render (step 3) | prototype | 2026-10-25 | `main` | `artifacts/web/src/prototypes/lesson-timeline/` (with its `questions.json` and ledger), written with its first version |

The scaffold is the repository's machinery, not a product feature. **Every
build step is in prototype phase until David declares it production**
(David, 2026-10-20: *"We don't need to harden any of this until we're sure
we like the way the system is running."*), and **each is added here by its
own one-line PR before its first version's planning loop opens**.

## Tester tier

- **Tier:** `tester` in the `users.tier` enum.
- **Setting that switches it on:** `TESTER_EMAIL` — the account named
  there is provisioned at web boot with the tester tier. In prototype phase
  the feedback rail and the Feedback page are open to both accounts (David,
  2026-10-25), so the tier no longer gates them.
- **Members:** in the development app, which has no sign-in in prototype
  phase (David, 2026-10-24), the page asks who you are: **Jared** is let in
  as the operator account, **David** as the tester account (David,
  2026-10-25: *"please swap the names and email addresses you have for David
  and Jared, they're backwards"* — the mapping of 2026-10-24 had Jared on the
  tester account). Each person's answers on the rail are recorded as theirs,
  and both read them on the Feedback page.
- **CI `push` trigger on `prototype/**`:** not declared. DojoOS is in the
  `main` regime; the trigger is added before the first branch-regime
  prototype, if one is ever needed.
