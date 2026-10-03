# Working agreements for DojoOS (Claude Code)

@.agents/core/claude-core.md

## What DojoOS is

DojoOS is the private, single-tenant platform for Bodywork Dojo, the
continuing-education business of Dr. Jared Cooper, DPT. It replaces Kajabi
one module at a time, starting with a video-production pipeline built
around how Jared shoots: he logs a shoot once, and the machine assembles a
lesson and a short from his bricks. Jared is the only operator and pays
nobody to edit or publish, so ease of use is the requirement. David is the
product manager.

## Product truth lives here

- **Brief** — [`docs/ai-context/product-brief.md`](docs/ai-context/product-brief.md)
- **Direction and roadmap** — [`docs/ai-context/product-direction.md`](docs/ai-context/product-direction.md), [`docs/ai-context/current-roadmap.md`](docs/ai-context/current-roadmap.md)
- **Architecture** — [`docs/ai-context/architecture.md`](docs/ai-context/architecture.md)
- **Glossary** — [`docs/ai-context/glossary.md`](docs/ai-context/glossary.md)
- **Settled decisions and why** — [`docs/ai-context/decisions.md`](docs/ai-context/decisions.md)
- **Workstream** — DojoOS issue #1 (increment 1)
- **Project board** — [board 2](https://github.com/users/TheAnswerManIsHere/projects/2), owned by `TheAnswerManIsHere`. `.github/workflows/project-sync.yml` mirrors each workstream issue's `stage:`/`waiting:`/`mode:` labels onto it, reading `PROJECT_OWNER` and `PROJECT_NUMBER` from the repository's Actions variables and `PROJECTS_TOKEN` from its secrets

## Product-specific skills

None yet. The handbook's skills cover everything so far.

## What the shared rules ask this repo

Answered in [`docs/ai-context/overlay-declarations.md`](docs/ai-context/overlay-declarations.md).

## Environment

The Repl, its database, its secrets and its disk are in
[`docs/ai-context/replit-environment.md`](docs/ai-context/replit-environment.md).
Footage lives in a private Backblaze B2 bucket reached only through
short-lived signed URLs; no media is ever public. There is no production
data yet and nothing is published, so every feature starts in prototype
phase on `main`.
