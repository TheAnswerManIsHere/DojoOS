// The logging viewer's command set (PLAN_LOGGING_VIEWER.md, the ci lane): every command, its undo, word snapping, and
// the preview's union of kept spans — pure functions, no database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCommand, isCommand, keepSpans, snapToWord, type Command, type SourceLog } from "@workspace/shared/commands";

const empty: SourceLog = { durationMs: 600_000, bricks: [] };
const run = (state: SourceLog, ...commands: Command[]) => commands.reduce((s, c) => applyCommand(s, c).state, state);
/** Applying a command and then its inverse gives back the state it started from. */
function roundTrip(state: SourceLog, command: Command) {
  const { state: after, inverse } = applyCommand(state, command);
  assert.deepEqual([...applyCommand(after, inverse).state.bricks].sort((a, b) => a.id.localeCompare(b.id)),
    [...state.bricks].sort((a, b) => a.id.localeCompare(b.id)), `${command.type} undoes cleanly`);
  return after;
}

test("the plan's walkthrough: nested open bricks, O closes the innermost, actions, tags, a nudge and its undo", () => {
  let s = run(empty, { type: "open", id: "b1", atMs: 40_120 }, { type: "open", id: "b2", atMs: 130_000 },
    { type: "setTags", id: "b2", tags: ["Short", " short ", ""] });
  assert.deepEqual(s.bricks.map((b) => [b.id, b.outMs, b.openSeq]), [["b1", null, 1], ["b2", null, 2]]);
  s = run(s, { type: "close", atMs: 145_000 });
  assert.equal(s.bricks.find((b) => b.id === "b2")!.outMs, 145_000, "O closed the innermost, brick 2");
  s = run(s, { type: "close", atMs: 365_000 }, { type: "setAction", id: "b1", action: "punch_in", preset: "lower third" });
  const b1 = s.bricks.find((b) => b.id === "b1")!;
  assert.deepEqual([b1.outMs, b1.action, b1.preset], [365_000, "punch_in", "lower third"]);
  assert.deepEqual(s.bricks.find((b) => b.id === "b2")!.tags, ["short"]);
  const { state: nudged, inverse } = applyCommand(s, { type: "nudge", id: "b2", edge: "out", deltaMs: 33 });
  assert.equal(nudged.bricks.find((b) => b.id === "b2")!.outMs, 145_033);
  assert.deepEqual(applyCommand(nudged, inverse).state, s, "Esc undid the nudge");
});

test("every command has an inverse that restores the state, undoing O back to an open brick included", () => {
  let s = run(empty, { type: "open", id: "a", atMs: 1000 }, { type: "open", id: "b", atMs: 2000 });
  s = roundTrip(s, { type: "close", atMs: 3000 });
  const closed = run(s, { type: "close", atMs: 3000 });
  const { inverse } = applyCommand(s, { type: "close", atMs: 3000 });
  assert.equal(inverse.type, "reopen");
  const reopened = applyCommand(closed, inverse).state;
  assert.deepEqual(reopened.bricks.find((b) => b.id === "b"), s.bricks.find((b) => b.id === "b"), "b is open again, in its place");
  for (const c of [{ type: "open", id: "c", atMs: 5000 }, { type: "nudge", id: "a", edge: "in", deltaMs: -500 },
    { type: "setAction", id: "a", action: "punch_in", preset: null }, { type: "setTags", id: "a", tags: ["lesson"] },
    { type: "delete", id: "a" }] as Command[]) roundTrip(closed, c);
});

test("commands that cannot apply are refused, not bent", () => {
  assert.throws(() => run(empty, { type: "close", atMs: 1000 }), /No open brick/);
  assert.throws(() => run(empty, { type: "open", id: "a", atMs: 5000 }, { type: "close", atMs: 4000 }), /after the in point/);
  assert.throws(() => run(empty, { type: "open", id: "a", atMs: 5000 }, { type: "nudge", id: "a", edge: "out", deltaMs: 10 }), /no out point/);
  const s = run(empty, { type: "open", id: "a", atMs: 5000 }, { type: "close", atMs: 5100 });
  assert.throws(() => run(s, { type: "nudge", id: "a", edge: "in", deltaMs: 200 }), /after the in point/);
  assert.equal(run(s, { type: "nudge", id: "a", edge: "in", deltaMs: -10_000 }).bricks[0].inMs, 0, "clamped to the source's start");
});

test("only well-formed commands of the set pass the route's check", () => {
  assert.equal(isCommand({ type: "open", id: "x", atMs: 1 }), true);
  assert.equal(isCommand({ type: "open", atMs: 1 }), false, "the route names an opened brick before checking");
  assert.equal(isCommand({ type: "setAction", id: "x", action: "explode", preset: null }), false);
  assert.equal(isCommand({ type: "drop table" }), false);
  assert.equal(isCommand(null), false);
});

test("I snaps to the nearest word start and O to the nearest word end; with no word near, or no transcript, the raw time stands", () => {
  const words = [{ start_ms: 40_120, end_ms: 40_500 }, { start_ms: 40_600, end_ms: 41_000 }];
  assert.equal(snapToWord(words, 40_300, "in"), 40_120);
  assert.equal(snapToWord(words, 40_900, "out"), 41_000);
  assert.equal(snapToWord(words, 40_700, "out"), 40_500, "the nearer of two word ends");
  assert.equal(snapToWord(words, 90_000, "in"), 90_000, "nothing within a second");
  assert.equal(snapToWord(null, 12_345, "out"), 12_345);
});

test("preview the keep is the union of closed bricks: overlap once, gaps skipped, open bricks excluded", () => {
  const s = run(empty, { type: "open", id: "lesson", atMs: 10_000 }, { type: "open", id: "short", atMs: 12_000 },
    { type: "close", atMs: 14_000 }, { type: "close", atMs: 20_000 }, { type: "open", id: "later", atMs: 30_000 },
    { type: "close", atMs: 35_000 }, { type: "open", id: "pending", atMs: 50_000 });
  assert.deepEqual(keepSpans(s.bricks), [{ inMs: 10_000, outMs: 20_000 }, { inMs: 30_000, outMs: 35_000 }]);
});
