# DojoOS — notes for Replit Agent

DojoOS is a private, single-tenant video-production pipeline for Bodywork
Dojo (Jared Cooper, DPT). The engineering contract for this repository is
`CLAUDE.md` and `AGENTS.md`; the design is `docs/ai-context/architecture.md`;
the environment is `docs/ai-context/replit-environment.md`. Read those
before changing anything.

## How work reaches this Repl

Product code is written by Claude Code on a branch, reviewed, merged to
`main`, and pulled here. Requests from Claude through the connector are
**operations**: run named commands and report their output, pull `main`,
apply a migration, take a measurement. Do not build features from those
requests unless the request says so explicitly, and say what you changed.

## Run & operate

- `node scripts/run-production.mjs` — the production command: supervises
  web and worker, exits non-zero if either dies.
- `pnpm --filter @workspace/web run dev` / `pnpm --filter @workspace/worker run dev`.
- `pnpm run typecheck`; `pnpm --filter @workspace/web lint`.
- Schema changes: edit `lib/shared/src/schema.ts`, then
  `pnpm --filter @workspace/shared run migrate:generate` and
  `pnpm --filter @workspace/shared run migrate`.

## Never

- **Never run `drizzle-kit push`, and never run the `push` or `push-force`
  scripts of `lib/db`.** `lib/db` is an unused template package with an
  empty schema; pushing it at the database would drop DojoOS's tables. It
  is being removed.
- No demo data, no public routes, no Replit Object Storage, no idle polling
  of the database (see `decisions.md`).
