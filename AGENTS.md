# DojoOS Agent Instructions

> Routing file for AI agents. The cross-agent working contract — how to
> behave, plan, review and ship — is in
> [`.agents/core/agents-core.md`](.agents/core/agents-core.md) and applies in
> full. **Read it first.** This file covers what is specific to DojoOS:
> where its truth lives and how to build and test it.

## Project context

- Before any product work: [`docs/ai-context/product-brief.md`](docs/ai-context/product-brief.md)
  and [`docs/ai-context/architecture.md`](docs/ai-context/architecture.md).
- Before re-raising a choice: [`docs/ai-context/decisions.md`](docs/ai-context/decisions.md).
- Words with a fixed meaning (brick, cut, revision, resolved EDL):
  [`docs/ai-context/glossary.md`](docs/ai-context/glossary.md).
- Environment: [`docs/ai-context/replit-environment.md`](docs/ai-context/replit-environment.md)
  and [`docs/ai-context/codex-environment.md`](docs/ai-context/codex-environment.md).

## What the shared rules ask this repo

Answered in [`docs/ai-context/overlay-declarations.md`](docs/ai-context/overlay-declarations.md).

## Setup, verification, and the CI gate

```
pnpm install
pnpm run typecheck
pnpm --filter @workspace/web lint
node --test scripts/__tests__/*.test.mjs
node scripts/check-uat-format.mjs
```

CI runs all of these on every pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Anything needing
the database, ffmpeg or real storage is verified in the Repl, per
[`docs/tests/TESTING.md`](docs/tests/TESTING.md).
