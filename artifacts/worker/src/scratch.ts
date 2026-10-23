// Where a worker command stages large files. An explicit TMPDIR wins; otherwise <repo>/tmp when it exists — the dev
// supervisor creates it on the workspace volume, because the Repl's /tmp is a 4 GB RAM disk too small for a long
// lesson (replit-environment.md) — and the system's temporary directory everywhere else.
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export function scratchDir(env: NodeJS.ProcessEnv = process.env, repoTmp = fileURLToPath(new URL("../../../tmp", import.meta.url))): string {
  if (env.TMPDIR) return tmpdir();
  return existsSync(repoTmp) ? repoTmp : tmpdir();
}
