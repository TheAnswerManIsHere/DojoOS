// DojoOS-owned (not synced). Fails if anything that runs as part of the
// workspace can run `drizzle-kit push`, which syncs a live database to
// whatever schema it is pointed at. An unused template package once carried
// `push` and `push-force` scripts over an empty schema, and the Repl's
// post-merge hook called `pnpm --filter db push` after every merge. Schema
// changes go through generated, reviewed migrations only
// (docs/engineering/migrations-and-backfills.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP = new Set(["node_modules", ".git", "dist", ".local", ".cache"]);

// Every package.json in the tree, not a hand-kept list of where packages
// live: a copy of the workspace layout drifts from pnpm-workspace.yaml.
function packageFiles(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) packageFiles(p, out);
    else if (entry.name === "package.json") out.push(p);
  }
  return out;
}

const PUSH = /drizzle-kit\s+push|\bpnpm\b[^#\n]*\s(run\s+)?push(-force)?\b/;

test("the walk finds the workspace's known packages", () => {
  const found = packageFiles().map((f) => relative(ROOT, f));
  // A walk that found nothing would pass the checks below having evaluated nothing.
  for (const known of ["package.json", "lib/shared/package.json", "artifacts/worker/package.json"]) {
    assert.ok(found.includes(known), `expected to find ${known}; found ${found.length} manifests`);
  }
});

test("no package script runs drizzle-kit push", () => {
  const offenders = [];
  for (const file of packageFiles()) {
    const scripts = JSON.parse(readFileSync(file, "utf8")).scripts ?? {};
    for (const [name, cmd] of Object.entries(scripts)) {
      if (/drizzle-kit\s+push/.test(cmd)) offenders.push(`${relative(ROOT, file)}: "${name}": ${cmd}`);
    }
  }
  assert.deepEqual(offenders, [], `schema-push scripts found:\n${offenders.join("\n")}`);
});

test("the Repl's post-merge hook runs no schema push", () => {
  const hook = join(ROOT, "scripts", "post-merge.sh");
  assert.ok(existsSync(hook), "scripts/post-merge.sh is the hook .replit names; it should exist");
  const offenders = readFileSync(hook, "utf8").split("\n")
    .map((line, i) => [i + 1, line.trim()])
    .filter(([, line]) => line && !line.startsWith("#") && PUSH.test(line));
  assert.deepEqual(offenders, [], `post-merge hook pushes a schema:\n${offenders.map(([n, l]) => `${n}: ${l}`).join("\n")}`);
});
