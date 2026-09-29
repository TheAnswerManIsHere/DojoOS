---
name: Separate worker deployment topology
description: Constraint when a background worker must have its own Reserved VM but the web app uses Replit-managed PostgreSQL.
---

One project publishes its artifacts together as one deployment; separate Reserved VM instances require separate Repls. Do not assume a second Repl automatically shares the first Repl's managed production database.

**Why:** Independent worker publishing and a project-scoped managed database are separate concerns. A worker running against its own Repl database will never see the web process's jobs.

**How to apply:** Before claiming a separate worker is deployable, establish an explicitly shared production Postgres connection (and matching storage configuration), or state that the requested topology is blocked.