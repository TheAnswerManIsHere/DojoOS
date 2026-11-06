// The one editor's timeline helpers (David, 2026-11-06): lanes for overlapping bricks, the transcript box's current
// word, and the zoom window's limits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assignLanes, clampView, currentWordIndex, minViewMs, zoomAround } from "@workspace/shared/timeline";

test("bricks that partly overlap take separate lanes; a containing brick sits above what it contains; lanes are reused", () => {
  const lanes = assignLanes([
    { id: "a", inMs: 0, endMs: 10_000 }, { id: "b", inMs: 5_000, endMs: 15_000 }, { id: "c", inMs: 2_000, endMs: 3_000 },
    { id: "d", inMs: 12_000, endMs: 20_000 }, { id: "e", inMs: 0, endMs: 1_000 },
  ]);
  assert.equal(lanes.get("a"), 0, "the longer of two starting together goes first");
  assert.equal(lanes.get("e"), 1);
  assert.equal(lanes.get("c"), 1, "inside a, after e ends: lane 1 again");
  assert.equal(lanes.get("b"), 1, "overlaps a, but c has ended by 5 s: lane 1");
  assert.equal(lanes.get("d"), 0, "a has ended: back in the top lane");
});

test("the current word is the last to have started, so a pause between words keeps the one just spoken", () => {
  const words = [{ start_ms: 1000 }, { start_ms: 1500 }, { start_ms: 5000 }];
  assert.equal(currentWordIndex(words, 500), -1);
  assert.equal(currentWordIndex(words, 1000), 0);
  assert.equal(currentWordIndex(words, 4999), 1, "in the silence after the second word");
  assert.equal(currentWordIndex(words, 9000), 2);
});

test("zoom stops at about three seconds across, never runs past the ends, and turns back into fit at full width", () => {
  assert.equal(clampView(0, 60_000, 0, 60_000), null);
  assert.deepEqual(clampView(0, 60_000, 59_000, 1_000), { fromMs: 60_000 - minViewMs, toMs: 60_000 });
  const v = zoomAround(0, 60_000, { fromMs: 0, toMs: 60_000 }, 2, 30_000)!;
  assert.deepEqual(v, { fromMs: 15_000, toMs: 45_000 }, "the anchor stays where it was on screen");
  assert.equal(zoomAround(0, 60_000, v, 0.25, 30_000), null, "zoomed out past the whole range: fit");
});
