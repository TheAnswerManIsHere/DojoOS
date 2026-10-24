// Step-2 journey through the logging viewer (PLAN_LOGGING_VIEWER.md, the scripted lane), on a playable clip: the
// proxy's signed URL points at the journey's placeholder bucket, and the browser is handed a locally made WebM for it,
// so playback, seeking and preview really run. The plan's walkthrough — nested bricks, word snapping and the raw
// override, tags, an action, a nudge and its undo, a reload — goes through the real command route; an open brick
// survives a reload and stays out of the preview; the preview skips a gap; a source with no transcript marks raw time;
// and the feature's questions render on the page.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { bricks, cutEvents, derivedKeys, feedback, shoots, sources, transcripts } from "@workspace/shared";
import { requireTestDatabase, startServer, testerEmail, type RunningServer } from "./harness";
import { openPage, signInFromPage } from "./browser";

const { db, pool } = requireTestDatabase();
let server: RunningServer;
let browser: Browser;
let shootId: string;
let sourceId: string;
let bareId: string;
let clip: Buffer;
/** The page's video element, as an in-page expression (strings, since the server's TypeScript carries no DOM types). */
const VIDEO = 'document.querySelector("[data-testid=video-log]")';

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "step2-"));
  const file = join(dir, "clip.webm");
  // Eight seconds of picture and tone, with cues, so the browser can seek it.
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30", "-f", "lavfi",
    "-i", "sine=frequency=440", "-t", "8", "-c:v", "libvpx", "-b:v", "300k", "-c:a", "libopus", "-y", file]);
  clip = readFileSync(file);
  const [shoot] = await db.insert(shoots).values({ name: `Step-2 journey ${Date.now()}` }).returning();
  shootId = shoot.id;
  const [ready] = await db.insert(sources).values({ shootId, role: "camera_a", originalKey: "originals/journey-step2", ingestState: "ready",
    durationMs: 8000, width: 320, height: 180, fps: 30 }).returning();
  sourceId = ready.id;
  const keys = derivedKeys(sourceId);
  await db.update(sources).set({ proxyKey: keys.proxy, spriteKey: keys.sprite, peaksKey: keys.peaks }).where(eq(sources.id, sourceId));
  await db.insert(transcripts).values({ sourceId, provider: "elevenlabs", version: "scribe_v2", words: [
    { text: "Release", start_ms: 1000, end_ms: 1400 }, { text: "the", start_ms: 1500, end_ms: 1700 },
    { text: "psoas.", start_ms: 2000, end_ms: 2600 }, { text: "Now", start_ms: 5000, end_ms: 5600 }] });
  const [bare] = await db.insert(sources).values({ shootId, role: "audio", originalKey: "originals/journey-step2-bare", ingestState: "ready",
    durationMs: 8000, fps: null }).returning();
  bareId = bare.id;
  await db.update(sources).set({ proxyKey: derivedKeys(bareId).proxy }).where(eq(sources.id, bareId));
  server = await startServer();
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
    await server?.stop();
  } finally {
    if (shootId) {
      const ids = [sourceId, bareId].filter(Boolean);
      await db.delete(cutEvents).where(inArray(cutEvents.sourceId, ids));
      await db.delete(bricks).where(inArray(bricks.sourceId, ids));
      await db.delete(transcripts).where(inArray(transcripts.sourceId, ids));
      await db.delete(feedback).where(eq(feedback.page, `/sources/${sourceId}/log`));
      await db.delete(sources).where(inArray(sources.id, ids));
      await db.delete(shoots).where(eq(shoots.id, shootId));
    }
    await pool.end();
  }
});

/** A page whose proxy requests get the clip, answered by byte range as the bucket does — without ranges the browser
 * cannot seek and snaps back to 0; the placeholder bucket answers nothing else. */
async function viewer(id: string): Promise<Page> {
  const page = await openPage(browser);
  await page.route("http://127.0.0.1:9/**", (route) => {
    if (!route.request().url().includes(".mp4")) return route.fulfill({ status: 404, body: "" });
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? "");
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : clip.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: "video/webm", body: clip.subarray(start, end + 1),
      headers: { "accept-ranges": "bytes", ...(range && { "content-range": `bytes ${start}-${end}/${clip.length}` }) } });
  });
  await signInFromPage(page, server.origin, testerEmail);
  await page.goto(`${server.origin}/sources/${id}/log`);
  await page.getByTestId("video-log").waitFor();
  await page.waitForFunction(`${VIDEO}?.readyState >= 1`);
  return page;
}
const seek = (page: Page, seconds: number) => page.evaluate(`(async () => {
  const v = ${VIDEO};
  v.pause();
  v.currentTime = ${seconds};
  await new Promise((resolve) => (v.seeking ? v.addEventListener("seeked", resolve, { once: true }) : resolve(null)));
})()`);
const liveBricks = () => db.select().from(bricks).where(and(eq(bricks.sourceId, sourceId), isNull(bricks.deletedAt))).orderBy(bricks.inMs);
/** Waits until the saved bricks satisfy a check: each key sends a command, and the save follows it. */
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for the saved state");
}

test("the walkthrough: nested bricks, snapping and the raw override, tags, an action, a nudge undone, all through a reload", async () => {
  const page = await viewer(sourceId);
  await seek(page, 1.1); await page.keyboard.press("i");
  await until(liveBricks, (b) => b.length === 1);
  await seek(page, 2.1); await page.keyboard.press("Shift+I");
  await until(liveBricks, (b) => b.length === 2);
  await page.keyboard.press("t");
  await page.getByTestId("input-tags").fill("short");
  await page.getByTestId("input-tags").press("Enter");
  await until(liveBricks, (b) => b.some((x) => x.tags.includes("short")));
  await seek(page, 2.55); await page.keyboard.press("o");
  await until(liveBricks, (b) => b.some((x) => x.outMs !== null));
  await seek(page, 5.5); await page.keyboard.press("o");
  await until(liveBricks, (b) => b.every((x) => x.outMs !== null));
  await page.keyboard.press("a");
  await until(liveBricks, (b) => b.some((x) => (x.attributes as { action?: string }).action === "punch_in"));
  await page.keyboard.press("Shift+Tab");
  await seek(page, 2.5); await page.keyboard.press("ArrowRight");
  await until(liveBricks, (b) => b.some((x) => x.outMs === 2633));
  await page.keyboard.press("Escape");
  const saved = await until(liveBricks, (b) => b.every((x) => x.outMs !== 2633));

  // The outer brick snapped to word edges both ends; the inner one's in point is the raw playhead (Shift), its out snapped.
  assert.deepEqual(saved.map((b) => [b.inMs, b.outMs]), [[1000, 5600], [2100, 2600]]);
  assert.deepEqual(saved.map((b) => (b.attributes as { action: string }).action), ["punch_in", "keep"], "A set the outer brick's action after O closed it");
  assert.deepEqual(saved[1].tags, ["short"]);
  const events = await db.select().from(cutEvents).where(eq(cutEvents.sourceId, sourceId));
  assert.equal(events.length, 8, "open, open, tags, close, close, action, nudge, and the undo's nudge: one source-owned event each");
  assert.ok(events.every((e) => e.cutId === null), "no cut is involved");

  await page.reload();
  await page.getByTestId(`text-brick-tags-${saved[1].id}`).filter({ hasText: "short" }).waitFor();
  assert.equal(await page.getByTestId(`text-brick-action-${saved[0].id}`).textContent(), "punch in · lower third");
  assert.equal(await page.getByTestId(`text-brick-out-${saved[1].id}`).textContent(), "0:02.60");
  await page.close();
});

test("an open brick survives a reload and stays out of the preview; the preview skips a gap and plays overlap once", async () => {
  const page = await viewer(sourceId);
  await seek(page, 6.5); await page.keyboard.press("i");
  const open = await until(liveBricks, (b) => b.some((x) => x.outMs === null));
  const openId = open.find((x) => x.outMs === null)!.id;
  await page.reload();
  await page.getByTestId("video-log").waitFor();
  await page.waitForFunction(`${VIDEO}?.readyState >= 1`);
  assert.equal(await page.getByTestId(`text-brick-out-${openId}`).textContent(), "open");

  // Kept so far: 1.0–5.6 s (the nested 2.1–2.6 s inside it). The open brick at 6.5 s is not kept yet, so the preview ends at 5.6 s.
  await seek(page, 5.3); await page.keyboard.press("p");
  await page.getByTestId("text-log-message").filter({ hasText: "Preview finished." }).waitFor({ timeout: 15_000 });
  const stoppedAt = await page.evaluate<number>(`${VIDEO}.currentTime`);
  assert.ok(stoppedAt < 6.4, `the preview stopped before the open brick (${stoppedAt})`);

  // Close it at 7.5 s: the keep is now 1.0–5.6 and 6.5–7.5, and the preview jumps the gap between them.
  await seek(page, 7.5); await page.keyboard.press("Shift+O");
  await until(liveBricks, (b) => b.every((x) => x.outMs !== null));
  await seek(page, 5.4); await page.keyboard.press("p");
  const times = await page.evaluate<number[]>(`(async () => {
    const v = ${VIDEO}, seen = [], end = performance.now() + 2500;
    while (performance.now() < end && !v.paused) { seen.push(v.currentTime); await new Promise((r) => setTimeout(r, 40)); }
    return seen;
  })()`);
  assert.ok(times.some((t) => t >= 6.5), `played on into the second span (${times.at(-1)})`);
  assert.ok(!times.some((t) => t > 5.75 && t < 6.45), "nothing in the gap between 5.6 s and 6.5 s was played");
  await page.close();
});

test("a source with no transcript marks the raw playhead, and the page carries the feature's questions", async () => {
  const page = await viewer(bareId);
  await page.getByTestId("transcript-strip").filter({ hasText: "No transcript" }).waitFor();
  await page.getByText("No thumbnail sprite for this source.").waitFor();
  await seek(page, 3.333); await page.keyboard.press("i");
  const [brick] = await until(() => db.select().from(bricks).where(eq(bricks.sourceId, bareId)), (b) => b.length === 1);
  assert.equal(brick.inMs, 3333);
  await page.close();

  const rail = await viewer(sourceId);
  await rail.getByText("How long did logging this lesson take").waitFor();
  const box = rail.locator("textarea").first();
  await box.fill("1–1.5×");
  await rail.getByRole("button", { name: "Submit answer" }).first().click();
  await rail.getByText("Answer submitted.").waitFor();
  const [answer] = await db.select().from(feedback).where(eq(feedback.page, `/sources/${sourceId}/log`));
  assert.equal(answer.questionKey, "logging-viewer.speed");
  await rail.close();
});
