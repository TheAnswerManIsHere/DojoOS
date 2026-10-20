import assert from "node:assert/strict";
import { test } from "node:test";
import { ingestable } from "./ingest";

test("ingest takes any complete original that still lacks its proxy, and nothing else", () => {
  const base = { deletedAt: null, proxyKey: null };
  for (const state of ["uploaded", "probing", "proxying", "transcribing", "failed", "ready"] as const)
    assert.equal(ingestable({ ...base, ingestState: state }), true, `${state} without a proxy`);
  assert.equal(ingestable({ ...base, ingestState: "uploading" }), false, "the browser is still uploading the original");
  assert.equal(ingestable({ ...base, ingestState: "ready", proxyKey: "proxies/x.mp4" }), false, "already has its proxy");
  assert.equal(ingestable({ ...base, ingestState: "uploaded", deletedAt: new Date() }), false, "deleted");
});
