// The lesson's command set and resolver (PLAN_LESSON_TIMELINE.md, the ci lane): architecture.md §5's worked example on
// the output clock, every command and its undo, a trim at its brick's edge, and a dissolve refused — on a transition,
// and on a removal or move that changes its neighbours — with the lesson left unchanged. Pure functions, no database.
import assert from "node:assert/strict";
import { test } from "node:test";
import { activeAt, edlLengthMs, resolveCut } from "@workspace/shared/edl";
import { applyLessonCommand, initialOrder, isLessonCommand, misfits, type LessonBrick, type LessonCommand, type LessonState } from "@workspace/shared/lesson";

const entry = (id: string, brickId: string, transition: "cut" | "dissolve" = "cut") => ({ id, brickId, trimInMs: 0, trimOutMs: 0, transition });
const resolve = (s: LessonState) => resolveCut({ orientation: "16:9" }, s.entries.map((e) => ({ entry: e, brick: s.bricks.find((b) => b.id === e.brickId)! })));

// The worked example, camera only (no b-roll in this version): B1 0:12–1:40, B3 6:50–10:55, B4 11:10–12:00 on one source.
const worked: LessonState = {
  bricks: [{ id: "B1", sourceId: "S", inMs: 12_000, outMs: 100_000, tags: [] }, { id: "B3", sourceId: "S", inMs: 410_000, outMs: 655_000, tags: [] },
    { id: "B4", sourceId: "S", inMs: 670_000, outMs: 720_000, tags: [] }],
  entries: [entry("e1", "B1", "dissolve"), entry("e3", "B3"), entry("e4", "B4")],
};

test("the worked example: B1 0–88 s, a 1 s dissolve, B3 87–332 s, a hard cut, B4 332–382 s, 382 s in all", () => {
  const edl = resolve(worked);
  assert.deepEqual(edl.picture.map((p) => [p.outStartMs, p.outEndMs]), [[0, 88_000], [87_000, 332_000], [332_000, 382_000]]);
  assert.deepEqual(edl.narration.map((n) => [n.outStartMs, n.outEndMs]), [[0, 88_000], [87_000, 332_000], [332_000, 382_000]], "narration overlaps the same second");
  assert.equal(edlLengthMs(edl), 382_000, "not 383: the overlap is subtracted once");
  assert.deepEqual(activeAt(edl, 87_500).map((a) => [a.sourceId, a.sourceMs, a.weight]), [["S", 99_500, 0.5], ["S", 410_500, 0.5]], "halfway through the dissolve");
  assert.deepEqual(activeAt(edl, 332_000).map((a) => a.sourceMs), [670_000], "the hard cut lands on B4's first frame");
});

test("every command has an inverse that restores the lesson", () => {
  const commands: LessonCommand[] = [
    { type: "add", entry: { ...entry("new", "B4") }, position: 1 }, { type: "remove", id: "e3" }, { type: "move", id: "e4", to: 0 },
    { type: "trim", id: "e3", edge: "in", deltaMs: 2000 }, { type: "trim", id: "e3", edge: "out", deltaMs: -2000 },
    { type: "setTransition", id: "e3", transition: "dissolve" },
  ];
  for (const c of commands) {
    const { state, inverse } = applyLessonCommand(worked, c);
    assert.notDeepEqual(state, worked, `${c.type} changed something`);
    assert.deepEqual(applyLessonCommand(state, inverse).state, worked, `${c.type} undoes cleanly`);
  }
  const trimmed = applyLessonCommand(worked, { type: "trim", id: "e3", edge: "in", deltaMs: 2000 }).state;
  assert.equal(edlLengthMs(resolve(trimmed)), 380_000, "the trim is the cut's own: the brick is unchanged");
  assert.deepEqual(trimmed.bricks, worked.bricks);
});

test("a trim stops at its brick's edge, and never past the other edge", () => {
  const out = applyLessonCommand(worked, { type: "trim", id: "e4", edge: "out", deltaMs: -1000 });
  const back = applyLessonCommand(out.state, { type: "trim", id: "e4", edge: "out", deltaMs: 5000 });
  assert.deepEqual(back.inverse, { type: "trim", id: "e4", edge: "out", deltaMs: -1000 }, "only the second there was to give back");
  assert.throws(() => applyLessonCommand(back.state, { type: "trim", id: "e4", edge: "out", deltaMs: 33 }), /already at the brick's end/);
  assert.throws(() => applyLessonCommand(worked, { type: "trim", id: "e1", edge: "in", deltaMs: -33 }), /already at the brick's start/);
  const deep = applyLessonCommand(worked, { type: "trim", id: "e4", edge: "in", deltaMs: 999_999 }).state;
  assert.ok(edlLengthMs(resolve(deep)) > 332_000, "a positive playable length stays");
});

test("a dissolve that would not fit is refused, and the lesson stays as it was", () => {
  const short: LessonState = {
    bricks: [{ id: "A", sourceId: "S", inMs: 0, outMs: 3000, tags: [] }, { id: "B", sourceId: "S", inMs: 5000, outMs: 8000, tags: [] },
      { id: "C", sourceId: "T", inMs: 0, outMs: 500, tags: [] }],
    entries: [entry("a", "A", "dissolve"), entry("b", "B"), entry("c", "C")],
  };
  assert.throws(() => applyLessonCommand(short, { type: "setTransition", id: "b", transition: "dissolve" }), /doesn't fit: brick 3 would be 0.5 s/);
  assert.throws(() => applyLessonCommand(short, { type: "remove", id: "b" }), /doesn't fit/, "removing B leaves A's dissolve facing C");
  assert.throws(() => applyLessonCommand(short, { type: "move", id: "c", to: 1 }), /doesn't fit/, "moving C next to A's dissolve");
  assert.throws(() => applyLessonCommand(short, { type: "trim", id: "a", edge: "in", deltaMs: 2500 }), /doesn't fit/, "trimming A shorter than its dissolve");
  const cut = applyLessonCommand(short, { type: "setTransition", id: "a", transition: "cut" }).state;
  assert.equal(applyLessonCommand(cut, { type: "remove", id: "b" }).state.entries.length, 2, "with the dissolve made a cut, the removal goes through");
  // Two dissolves into and out of one 1.5 s brick would overlap inside it.
  const mid: LessonState = { ...short, bricks: short.bricks.map((b) => (b.id === "B" ? { ...b, outMs: 6500 } : b.id === "C" ? { ...b, outMs: 3000 } : b)) };
  assert.throws(() => applyLessonCommand(mid, { type: "setTransition", id: "b", transition: "dissolve" }), /doesn't fit: brick 2/);
  assert.deepEqual(misfits(short), []);
});

test("a lesson already out of fit does not block edits that add no new misfit", () => {
  const broken: LessonState = { ...worked, bricks: worked.bricks.map((b) => (b.id === "B1" ? { ...b, outMs: 12_500 } : b)) };
  assert.deepEqual(misfits(broken), ["e1"]);
  assert.equal(applyLessonCommand(broken, { type: "trim", id: "e4", edge: "in", deltaMs: 1000 }).state.entries.length, 3);
  assert.equal(resolve(broken).picture[0].transitionOut, "dissolve:500", "the resolver shortens it to fit rather than dropping it");
});

test("the first membership is every closed brick, file by file in the order added, then by in point, ties by id", () => {
  const bricks: LessonBrick[] = [
    { id: "z", sourceId: "second", inMs: 0, outMs: 1, tags: [] }, { id: "b", sourceId: "first", inMs: 5, outMs: 9, tags: [] },
    { id: "a", sourceId: "first", inMs: 5, outMs: 7, tags: ["short"] }, { id: "c", sourceId: "first", inMs: 1, outMs: 2, tags: [] },
  ];
  assert.deepEqual(initialOrder(bricks, ["first", "second"]).map((b) => b.id), ["c", "a", "b", "z"]);
});

test("only well-formed commands of the lesson's set pass the route's check", () => {
  assert.equal(isLessonCommand({ type: "move", id: "x", to: 2 }), true);
  assert.equal(isLessonCommand({ type: "move", id: "x", to: -1 }), false);
  assert.equal(isLessonCommand({ type: "setTransition", id: "x", transition: "wipe" }), false);
  assert.equal(isLessonCommand({ type: "add", entry: { id: "e", brickId: "b", trimInMs: -5, trimOutMs: 0, transition: "cut" }, position: 0 }), false);
  assert.equal(isLessonCommand({ type: "open", id: "x", atMs: 1 }), false, "a logging command is not a lesson command");
});

test("a punch-in brick resolves to a framing region its preset places; a keep resolves to none", async () => {
  const { punchInRegion, regionTransform } = await import("@workspace/shared/edl");
  const lower = punchInRegion("lower third"), upper = punchInRegion("upper third");
  assert.deepEqual([lower.w, lower.y].map((v) => +v.toFixed(4)), [0.6667, 0.3333]);
  assert.equal(upper.y, 0);
  const edl = resolveCut({ orientation: "16:9" }, [
    { entry: { id: "e1", brickId: "b1", trimInMs: 0, trimOutMs: 0, transition: "cut" }, brick: { id: "b1", sourceId: "s", inMs: 0, outMs: 1000, tags: [], action: "punch_in", preset: "lower third" } },
    { entry: { id: "e2", brickId: "b2", trimInMs: 0, trimOutMs: 0, transition: "cut" }, brick: { id: "b2", sourceId: "s", inMs: 1000, outMs: 2000, tags: [], action: "keep" } },
  ]);
  assert.deepEqual(edl.picture.map((p) => p.framing.length), [1, 0]);
  // On a player: scaled 1.5×, anchored so the region's bottom stays on the frame's bottom.
  assert.deepEqual(regionTransform(lower), { transform: "scale(1.5)", transformOrigin: "50.00% 100.00%" });
  assert.deepEqual(regionTransform(undefined), { transform: "", transformOrigin: "" });
});
