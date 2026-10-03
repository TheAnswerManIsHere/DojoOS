---
name: Worker database idle cost constraint
description: Why DojoOS must not add frequent database polling to its worker.
---

The user requires a nudge-driven worker, not idle claim loops. Startup and nudges drain claimable jobs; an idle safety check is no more frequent than six hours. In-flight/startup-observed claims may schedule their lease-expiry attempts.

**Why:** The user explicitly identified continuous worker polling as keeping the database active around the clock, with money behind removing it.

**How to apply:** Do not introduce short database error-retry timers, heartbeat queries, or idle queue polling during future worker changes. Keep tests and verification separate from recurring production behavior.