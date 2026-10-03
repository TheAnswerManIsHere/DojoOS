# Testing — DojoOS

| What | Command | Where |
|---|---|---|
| Typecheck, every package | `pnpm run typecheck` | CI and locally |
| Web lint, including the module-boundary rule | `pnpm --filter @workspace/web lint` | CI and locally |
| Worker and queue unit tests | `artifacts/worker/src/*.test.ts` (node:test) | in the Repl; no package script runs them yet, and the queue test needs the development database |
| Handbook machinery tests | `node --test scripts/__tests__/*.test.mjs` | CI and locally |
| Docs accuracy | `node scripts/check-docs-accuracy.mjs` | not in CI yet: it fails on synced handbook files that cite other products' paths (see `docs/engineering/deferred-work.md`) |
| UAT document format | `node scripts/check-uat-format.mjs` | CI |

Prototype-phase features carry no test bar until David flips them to
production. The pure functions at the centre (`resolveCut`,
`clipRevision`, `applyCommand`) get unit tests when they are first
implemented, because every feature depends on them.
