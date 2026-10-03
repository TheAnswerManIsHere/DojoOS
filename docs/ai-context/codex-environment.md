# DojoOS — the Codex environment

Codex reviews pull requests through its GitHub connector and, when asked,
runs in a cloud sandbox from this repository.

- **What a sandbox needs:** Node 20+, pnpm, and for worker code ffmpeg. No
  database is available there; anything needing Postgres is verified in
  the Repl instead.
- **What runs there:** `pnpm install`, `pnpm run typecheck`, the web lint,
  and the handbook's node test suites (`node --test scripts/__tests__/`).
- **Setup script:** none yet. One is added when a Codex task first needs
  more than the list above.
