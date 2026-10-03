// DojoOS-owned (not synced). Fails if any workspace package script can run
// `drizzle-kit push`, which syncs a live database to whatever schema the
// package declares. An unused template package once carried `push` and
// `push-force` scripts over an empty schema; run against the development or
// production database, that would have dropped DojoOS's tables. Schema
// changes go through generated, reviewed migrations only
// (docs/engineering/migrations-and-backfills.md).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function packageFiles() {
  const files = [join(ROOT, "package.json")];
  for (const group of ["artifacts", "lib", "scripts"]) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) continue;
    if (existsSync(join(dir, "package.json"))) files.push(join(dir, "package.json"));
    for (const name of readdirSync(dir)) {
      const p = join(dir, name, "package.json");
      if (existsSync(p)) files.push(p);
    }
  }
  return files;
}

test("no workspace package script runs drizzle-kit push", () => {
  const offenders = [];
  for (const file of packageFiles()) {
    const scripts = JSON.parse(readFileSync(file, "utf8")).scripts ?? {};
    for (const [name, cmd] of Object.entries(scripts)) {
      if (/drizzle-kit\s+push/.test(cmd)) offenders.push(`${file.slice(ROOT.length + 1)}: "${name}": ${cmd}`);
    }
  }
  assert.deepEqual(offenders, [], `schema-push scripts found:\n${offenders.join("\n")}`);
});
