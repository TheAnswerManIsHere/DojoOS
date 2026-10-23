// The pilot's scoring on hand-made runs and synthetic audio, where the right answer is known.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TimedWord } from "@workspace/shared";
import { find, frameDb, noiseFloor, normalise, scoreEdges, scoreFillers, scorePhrase, wav, type Run } from "./pilot-score";

const words = (...spec: Array<[string, number, number]>): TimedWord[] => spec.map(([text, start_ms, end_ms]) => ({ text, start_ms, end_ms }));

test("normalising drops punctuation and possessives and splits hyphens", () => {
  assert.deepEqual(normalise("Editor, punch-in NOW."), ["editor", "punch", "in", "now"]);
  assert.deepEqual(normalise("psoas's"), ["psoas"]);
});

test("a phrase is found across word splits and plurals, with its span's times", () => {
  const run: Run = { config: "a", provider: "p", words: words(["Editor,", 0, 400], ["punch-in", 450, 800], ["now.", 820, 1000], ["fascias", 2000, 2500]) };
  assert.deepEqual(find(run, "editor punch in now"), [{ config: "a", start_ms: 0, end_ms: 1000, heard: "Editor, punch-in now." }]);
  assert.equal(find(run, "fascia").length, 1);
  assert.equal(find(run, "psoas").length, 0);
});

test("agreement is by provider: more configurations of one provider cannot set the reference alone", () => {
  const runs: Run[] = [
    { config: "x1", provider: "x", words: words(["psoas", 1000, 1400], ["psoas", 9000, 9400]) },
    { config: "y1", provider: "y", words: words(["psoas", 1100, 1500], ["psoas", 20000, 20400]) },
    { config: "y2", provider: "y", words: words(["so", 1000, 1200], ["as", 1200, 1400], ["psoas", 20050, 20400]) },
    { config: "y3", provider: "y", words: words(["psoas", 20100, 20500]) },
  ];
  const { agreed, disputed, scores } = scorePhrase(runs, "psoas");
  assert.equal(agreed, 1, "only the occurrence both providers heard; three y configurations at 20 s do not make it agreed");
  assert.equal(disputed, 2);
  assert.deepEqual(scores.map((s) => [s.config, s.found, s.recall, s.disputed, s.alone]),
    [["x1", 2, 1, 1, 1], ["y1", 2, 1, 1, 0], ["y2", 1, 0, 1, 0], ["y3", 1, 0, 1, 0]]);
});

test("fillers are counted, and timed only when they carry a duration", () => {
  const run: Run = { config: "a", provider: "p", words: words(["Um,", 0, 200], ["uh", 300, 300], ["so", 400, 600]) };
  assert.deepEqual(scoreFillers(run), { config: "a", fillers: 2, timed: 1, medianMs: 200 });
});

test("an edge placed inside the speech is clipped; one at the speech's edge is not", () => {
  // One second of silence-level noise, a 500 ms tone from 1.0 s to 1.5 s, one second of noise.
  const samples = new Int16Array(16000 * 2.5);
  for (let i = 0; i < samples.length; i++) samples[i] = ((i * 7919) % 41) - 20;
  for (let i = 16000; i < 24000; i++) samples[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 16000));
  const db = frameDb(samples), floor = noiseFloor(db);
  const exact = scoreEdges({ config: "exact", provider: "p", words: words(["ah", 1000, 1500]) }, db, floor);
  assert.equal(exact.edges, 2);
  assert.equal(exact.clipped, 0);
  assert.ok(exact.medianAbsMs! <= 10, `median ${exact.medianAbsMs}`);
  const early = scoreEdges({ config: "early", provider: "p", words: words(["ah", 1080, 1420]) }, db, floor);
  assert.equal(early.clipped, 2, "80 ms in at each end clips both");
});

test("a rendered cut is a playable WAV of exactly the span", () => {
  const out = wav(new Int16Array(16000), 250, 500);
  assert.equal(out.toString("ascii", 0, 4), "RIFF");
  assert.equal(out.readUInt32LE(40), 4000 * 2);
});
