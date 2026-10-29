// The navigation every player shares (David, 2026-10-29): ← / → by word, a second where no word is within five
// seconds, Shift five seconds, Option one frame; J / K / L the speed. Pure functions, no browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { navigationTarget, nextSpeed } from "@workspace/shared/navigation";

const words = [{ start_ms: 1000, end_ms: 1400 }, { start_ms: 1500, end_ms: 1900 }, { start_ms: 12_000, end_ms: 12_500 }];
const go = (at: number, dir: -1 | 1, mod: "none" | "shift" | "option" = "none") => navigationTarget(words, at, dir, mod, 1000 / 30, 20_000);

test("→ and ← step to the next and previous word start", () => {
  assert.equal(go(0, 1), 1000);
  assert.equal(go(1000, 1), 1500);
  assert.equal(go(1800, -1), 1500, "from well inside a word, back to its start");
  assert.equal(go(1600, -1), 1000, "pressed within a quarter second of a word's start, back to the word before");
});

test("where no word is within five seconds, each press moves one second", () => {
  assert.equal(go(1500, 1), 2500, "the next word is 10.5 s away");
  assert.equal(go(6500, 1), 7500);
  assert.equal(go(7500, 1), 12_000, "a word within 5 s again: it lands on it");
  assert.equal(go(11_000, -1), 10_000, "back through the silence a second at a time");
  assert.equal(navigationTarget(null, 3000, 1, "none", 33, 20_000), 4000, "no transcript: a second");
});

test("Shift moves five seconds, Option one frame, and nothing goes past either end", () => {
  assert.equal(go(1000, 1, "shift"), 6000);
  assert.equal(Math.round(go(1000, 1, "option")), 1033);
  assert.equal(go(2000, -1, "shift"), 0);
  assert.equal(go(19_500, 1, "shift"), 20_000);
});

test("J slows, L speeds up, K is 1×, and the ends hold", () => {
  assert.equal(nextSpeed(1, "slower"), 0.75);
  assert.equal(nextSpeed(1, "faster"), 1.25);
  assert.equal(nextSpeed(0.25, "slower"), 0.25);
  assert.equal(nextSpeed(2, "faster"), 2);
  assert.equal(nextSpeed(1.5, "normal"), 1);
});
