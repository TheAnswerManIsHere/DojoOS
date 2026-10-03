# Migrations and backfills — DojoOS

- **Drizzle owns the schema.** The schema is `lib/shared/src/schema.ts`;
  migrations are generated into `lib/shared/drizzle` with the shared
  package's `migrate:generate` script and applied with its `migrate`
  script.
- **A merged migration file is immutable.** A later change is a new
  migration, never an edit to an applied one.
- **Never push schema straight at a database.** `drizzle-kit push` is
  denied in `.claude/settings.json`; the only path is a generated, reviewed
  migration.
- **Production schema changes are applied by Replit's publish flow**, not
  by startup-time DDL. A migration that needs data moved ships the
  backfill as its own step, idempotent and resumable, and says in the PR
  how it was run against the development database first.
- **Destructive changes** (a dropped column or table, a type narrowing)
  need David's explicit approval in the PR, since the publish applies them
  to the production database.
