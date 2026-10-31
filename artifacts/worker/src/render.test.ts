// The lesson render's scripted lane (PLAN_LESSON_TIMELINE.md, increment test): two generated files of one shoot whose
// picture says which file and which second is showing (red or blue, green rising 25 a second) and whose tone says which
// file is sounding (440 Hz or 1 kHz), arranged in the worked example's camera-only shape — three bricks, a 1 s dissolve
// crossing from one file to the other, then a hard cut back. The render must have the resolver's length to within a
// frame, and at every sampled output time show and sound what the resolved EDL says.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { activeAt, edlLengthMs, resolveCut, type LessonBrick, type LessonEntry } from "@workspace/shared";
import { probe } from "./media";
import { renderArgs } from "./render";

const dir = mkdtempSync(join(tmpdir(), "render-test-"));
export const fixtureSources = { A: { red: 200, blue: 0, tone: 440 }, B: { red: 0, blue: 200, tone: 1000 } } as const;

/** One fixture file: ten seconds of picture and tone that identify it and the second showing. */
export function makeFixture(file: string, which: keyof typeof fixtureSources, codec: "webm" | "mp4" = "mp4") {
  const { red, blue, tone } = fixtureSources[which];
  const video = codec === "webm" ? ["-c:v", "libvpx", "-b:v", "400k", "-c:a", "libopus"] : ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"];
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    `color=c=black:s=320x180:r=30:d=10,format=gbrp,geq=r=${red}:g='25*floor(T)':b=${blue}`, "-f", "lavfi", "-i", `sine=frequency=${tone}:duration=10`,
    ...video, "-g", "15", "-y", file]);
}

/** The picture's mean colour at one time. */
export function colourAt(file: string, seconds: number): [number, number, number] {
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", seconds.toFixed(3), "-i", file, "-frames:v", "1",
    "-vf", "scale=8:8:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const sum = [0, 0, 0];
  for (let i = 0; i < raw.length; i += 3) for (let c = 0; c < 3; c++) sum[c] += raw[i + c];
  return sum.map((v) => v / (raw.length / 3)) as [number, number, number];
}

/** How strongly each tone sounds over 100 ms at one time (Goertzel on mono 8 kHz). */
export function tonesAt(file: string, seconds: number, freqs: number[]): number[] {
  const raw = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", seconds.toFixed(3), "-i", file, "-t", "0.1", "-vn",
    "-ac", "1", "-ar", "8000", "-f", "s16le", "-"]);
  const x = Array.from({ length: raw.length / 2 }, (_, i) => raw.readInt16LE(2 * i) / 32768);
  return freqs.map((f) => {
    const k = (2 * Math.cos((2 * Math.PI * f) / 8000));
    let s1 = 0, s2 = 0;
    for (const v of x) { const s0 = v + k * s1 - s2; s2 = s1; s1 = s0; }
    return Math.sqrt(s1 * s1 + s2 * s2 - k * s1 * s2) / x.length;
  });
}

const bricks: LessonBrick[] = [
  { id: "b1", sourceId: "A", inMs: 0, outMs: 3000, tags: [] },
  { id: "b2", sourceId: "B", inMs: 1000, outMs: 5000, tags: [] },
  { id: "b3", sourceId: "A", inMs: 5000, outMs: 7000, tags: [] },
];
const entries: LessonEntry[] = [
  { id: "e1", brickId: "b1", trimInMs: 0, trimOutMs: 0, transition: "dissolve" },
  { id: "e2", brickId: "b2", trimInMs: 0, trimOutMs: 0, transition: "cut" },
  { id: "e3", brickId: "b3", trimInMs: 0, trimOutMs: 0, transition: "cut" },
];
export const fixtureEdl = resolveCut({ orientation: "16:9" }, entries.map((entry) => ({ entry, brick: bricks.find((b) => b.id === entry.brickId)! })));

let output: string;
before(() => {
  makeFixture(join(dir, "a.mp4"), "A");
  makeFixture(join(dir, "b.mp4"), "B");
  output = join(dir, "render.mp4");
  const inputs = new Map([["A", { file: join(dir, "a.mp4"), hasVideo: true, hasAudio: true }], ["B", { file: join(dir, "b.mp4"), hasVideo: true, hasAudio: true }]]);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...renderArgs(fixtureEdl, inputs, output)]);
});

test("the render runs the resolver's length to within one frame, at the render size", async () => {
  assert.equal(edlLengthMs(fixtureEdl), 8000, "3 + 4 + 2 seconds, less the one-second dissolve");
  const probed = await probe(output, new AbortController().signal);
  assert.ok(Math.abs(probed.durationMs! - 8000) <= 34, `length ${probed.durationMs} ms`);
  assert.deepEqual([probed.width, probed.height], [1920, 1080]);
});

test("at each boundary, inside the dissolve and either side of the hard cut, the render shows and sounds what the EDL says", () => {
  for (const t of [500, 1500, 2050, 2500, 2950, 3500, 5900, 6100, 7500]) {
    const active = activeAt(fixtureEdl, t);
    const [r, g, b] = colourAt(output, t / 1000);
    const [low, high] = tonesAt(output, t / 1000 - 0.05, [440, 1000]);
    const share = (src: "A" | "B") => active.filter((a) => a.sourceId === src).reduce((sum, a) => sum + a.weight, 0);
    const where = `at ${t} ms (expected ${JSON.stringify(active)}; saw rgb ${[r, g, b].map(Math.round)}, tones ${low.toFixed(3)}/${high.toFixed(3)})`;
    assert.ok(Math.abs(r - 200 * share("A")) < 30 && Math.abs(b - 200 * share("B")) < 30, `picture ${where}`);
    if (active.length === 1) {
      const second = Math.floor(active[0].sourceMs / 1000);
      assert.ok(Math.abs(g - 25 * second) < 12, `the source's second (${second}) ${where}`);
      const [want, other] = active[0].sourceId === "A" ? [low, high] : [high, low];
      assert.ok(want > 0.02 && other < want / 5, `sound ${where}`);
    } else if (Math.min(...active.map((a) => a.weight)) >= 0.25) assert.ok(low > 0.01 && high > 0.01, `both tones inside the dissolve ${where}`);
  }
});

test("a punch-in brick is rendered framed: the preset's part of the picture fills the frame (David, 2026-10-30)", () => {
  // A source whose blue rises from the top of the frame to the bottom: the mean blue says which part of it is showing.
  const ramp = join(dir, "ramp.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=3,format=gbrp,geq=r=0:g=0:b='255*Y/H'",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv444p", "-crf", "10", "-c:a", "aac", "-y", ramp]);
  const inputs = new Map([["R", { file: ramp, hasVideo: true, hasAudio: true }]]);
  const blueOf = (action: "keep" | "punch_in", preset: string | null) => {
    const brick: LessonBrick = { id: "r", sourceId: "R", inMs: 0, outMs: 2000, tags: [], action, preset };
    const edl = resolveCut({ orientation: "16:9" }, [{ entry: { id: "e", brickId: "r", trimInMs: 0, trimOutMs: 0, transition: "cut" }, brick }]);
    const out = join(dir, `ramp-${action}-${preset ?? "none"}.mp4`);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...renderArgs(edl, inputs, out)]);
    return colourAt(out, 1)[2];
  };
  const keep = blueOf("keep", null), lower = blueOf("punch_in", "lower third"), upper = blueOf("punch_in", "upper third"), centre = blueOf("punch_in", "centre");
  // At 1.5×: the whole frame averages half way; the lower third's crop is the bottom two thirds (≈ 2/3), the upper the top two thirds (≈ 1/3).
  assert.ok(Math.abs(keep - 127) < 15, `keep shows the whole frame (${keep})`);
  assert.ok(Math.abs(lower - 170) < 15, `lower third shows the bottom of the frame (${lower})`);
  assert.ok(Math.abs(upper - 85) < 15, `upper third shows the top of the frame (${upper})`);
  assert.ok(Math.abs(centre - 127) < 15, `centre shows the middle (${centre})`);
});
