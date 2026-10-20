// The ingest derivatives, made from generated clips with the real ffmpeg. Needs ffmpeg and
// ffprobe on PATH (CI installs them; the Repl has them from replit.nix) and fails without them
// rather than skipping: a check that cannot run must not report success.
import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peaksPerSecond, spriteLayout, type Peaks } from "@workspace/shared";
import { makePeaks, makeProxy, makeSprite } from "./media";

let dir: string;
const signal = new AbortController().signal;

function generate(file: string, { width, height, seconds, audio }: { width: number; height: number; seconds: number; audio: boolean }) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=30:duration=${seconds}`,
    ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`] : []),
    "-c:v", "libx264", "-preset", "ultrafast", ...(audio ? ["-c:a", "aac"] : []), "-shortest", file]);
}

function probe(file: string) {
  const out = execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]).toString();
  return JSON.parse(out) as { format: { duration: string }; streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number }> };
}

before(async () => {
  for (const tool of ["ffmpeg", "ffprobe"]) execFileSync(tool, ["-version"]); // throws, and fails the suite, when missing
  dir = await mkdtemp(join(tmpdir(), "dojo-media-test-"));
  generate(join(dir, "landscape.mp4"), { width: 1280, height: 720, seconds: 8, audio: true });
  generate(join(dir, "portrait.mp4"), { width: 720, height: 1280, seconds: 4, audio: false });
  generate(join(dir, "large.mp4"), { width: 2560, height: 1440, seconds: 2, audio: true });
});
after(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

test("the proxy is H.264/AAC, keeps a 720p source's size, and starts with its index for range playback", async () => {
  const out = join(dir, "landscape.proxy.mp4");
  const cost = await makeProxy(join(dir, "landscape.mp4"), out, signal, { hasVideo: true, hasAudio: true });
  const info = probe(out);
  const video = info.streams.find((s) => s.codec_type === "video")!;
  const audio = info.streams.find((s) => s.codec_type === "audio")!;
  assert.equal(video.codec_name, "h264");
  assert.equal(audio.codec_name, "aac");
  assert.deepEqual([video.width, video.height], [1280, 720]);
  assert.ok(Math.abs(Number(info.format.duration) - 8) < 0.2);
  const head = (await readFile(out)).subarray(0, 4096).toString("latin1");
  assert.ok(head.indexOf("moov") !== -1 && head.indexOf("moov") < head.indexOf("mdat") || head.indexOf("mdat") === -1, "moov precedes mdat (faststart)");
  assert.ok(cost.wallMs > 0 && cost.bytes > 0);
  assert.ok(cost.maxRssKiB !== null && cost.maxRssKiB > 0, "ffmpeg's own peak memory is read from its -benchmark report");
});

test("a source larger than 1080p is scaled to fit 1920×1080; a portrait source keeps its orientation; no audio is no audio", async () => {
  const large = join(dir, "large.proxy.mp4");
  await makeProxy(join(dir, "large.mp4"), large, signal, { hasVideo: true, hasAudio: true });
  const big = probe(large).streams.find((s) => s.codec_type === "video")!;
  assert.deepEqual([big.width, big.height], [1920, 1080]);
  const portrait = join(dir, "portrait.proxy.mp4");
  await makeProxy(join(dir, "portrait.mp4"), portrait, signal, { hasVideo: true, hasAudio: false });
  const info = probe(portrait);
  const tall = info.streams.find((s) => s.codec_type === "video")!;
  assert.deepEqual([tall.width, tall.height], [720, 1280]);
  assert.equal(info.streams.some((s) => s.codec_type === "audio"), false);
});

test("an audio-only source gets an audio-only proxy", async () => {
  const input = join(dir, "voice.m4a");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=3", "-c:a", "aac", input]);
  const out = join(dir, "voice.proxy.mp4");
  await makeProxy(input, out, signal, { hasVideo: false, hasAudio: true });
  const info = probe(out);
  assert.deepEqual(info.streams.map((s) => s.codec_type), ["audio"]);
});

test("the sprite is one JPEG grid sized exactly as spriteLayout says", async () => {
  const proxy = join(dir, "landscape.proxy.mp4");
  const out = join(dir, "landscape.sprite.jpg");
  await makeSprite(proxy, out, 8000, 1280, 720, signal);
  const layout = spriteLayout(8000, 1280, 720);
  assert.deepEqual(layout, { intervalSeconds: 2, count: 4, columns: 10, rows: 1, tileWidth: 160, tileHeight: 90 });
  const image = probe(out).streams[0];
  assert.equal(image.codec_name, "mjpeg");
  assert.deepEqual([image.width, image.height], [layout.columns * layout.tileWidth, layout.rows * layout.tileHeight]);
});

test("the sprite layout caps the tile count for a long source and keeps the frame's shape", () => {
  const hour = spriteLayout(60 * 60_000, 1920, 1080);
  assert.ok(hour.count <= 300);
  assert.equal(hour.intervalSeconds, 12);
  assert.equal(hour.rows, Math.ceil(hour.count / 10));
  assert.equal(spriteLayout(10_000, 720, 1280).tileHeight, 284);
  assert.throws(() => spriteLayout(0, 1920, 1080));
});

test("peaks carry one min/max pair per 50 ms of audio, at the tone's level throughout", async () => {
  const out = join(dir, "landscape.peaks.json");
  await makePeaks(join(dir, "landscape.proxy.mp4"), out, true, signal);
  const peaks = JSON.parse(await readFile(out, "utf8")) as Peaks;
  assert.equal(peaks.samples_per_pixel, 8000 / peaksPerSecond);
  assert.ok(Math.abs(peaks.length - 8 * peaksPerSecond) <= 2, `about ${8 * peaksPerSecond} pairs, got ${peaks.length}`);
  assert.equal(peaks.data.length, peaks.length * 2);
  // lavfi's sine is one eighth of full scale (±4095 of ±32767), which is ±15 or ±16 on the 8-bit scale. The first
  // and last second are left out: AAC rings on a tone that starts and stops abruptly (the first 50 ms reads ±30).
  const steady = peaks.data.slice(2 * peaksPerSecond, peaks.data.length - 2 * peaksPerSecond);
  const loudest = Math.max(...steady.map(Math.abs));
  assert.ok(loudest >= 13 && loudest <= 18, `the tone's level survives the proxy's AAC (${loudest})`);
  assert.ok(steady.every((v) => Math.abs(v) >= 12), "every pair inside the tone shows it: no flat stretches, no -3 dB downmix");
  assert.ok(peaks.data.every((v) => v >= -128 && v <= 127));
});

test("a source with no audio gets an empty peaks file, not a failure", async () => {
  const out = join(dir, "portrait.peaks.json");
  const cost = await makePeaks(join(dir, "portrait.mp4"), out, false, signal);
  const peaks = JSON.parse(await readFile(out, "utf8")) as Peaks;
  assert.equal(peaks.length, 0);
  assert.equal(cost.wallMs, 0);
});

test("an aborted encode stops and rejects instead of finishing", async () => {
  const controller = new AbortController();
  const pending = makeProxy(join(dir, "large.mp4"), join(dir, "aborted.mp4"), controller.signal, { hasVideo: true, hasAudio: true });
  controller.abort();
  await assert.rejects(pending);
});
