// Where large files are staged: TMPDIR if set, else the repository's tmp folder when it exists, else the system's.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scratchDir } from "./scratch";

test("an explicit TMPDIR wins, then an existing repository tmp folder, then the system's", () => {
  const repoTmp = mkdtempSync(join(tmpdir(), "repo-tmp-"));
  assert.equal(scratchDir({ TMPDIR: "/x" }, repoTmp), tmpdir());
  assert.equal(scratchDir({}, repoTmp), repoTmp);
  assert.equal(scratchDir({}, join(repoTmp, "missing")), tmpdir());
});
