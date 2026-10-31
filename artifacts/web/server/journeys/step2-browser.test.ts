// Step-2 journey through the logging viewer (PLAN_LOGGING_VIEWER.md, the scripted lane), on a playable clip: the
// proxy's signed URL points at the journey's placeholder bucket, and the browser is handed a locally made WebM for it,
// so playback and seeking really run. The walkthrough — nested bricks, word snapping and the raw override, Tab among
// open bricks, a note and a label, an action, the brick editor's edge moves, undo and redo, a reload — goes through the
// real command route; the arrows and a drag scrub, J/K/L set the speed, Delete asks first, the editor loops its brick;
// a source with no transcript marks raw time; and the feature's questions render on the page.
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

test("the walkthrough: nested bricks, Tab between open ones, O closes the selected one, a note, a label, A, the brick editor, undo and redo, done, through a reload", async () => {
  const page = await viewer(sourceId);
  await page.getByTestId("text-log-status").filter({ hasText: "Not started" }).waitFor();
  await seek(page, 1.1); await page.keyboard.press("i");
  await until(liveBricks, (b) => b.length === 1);
  await page.getByTestId("text-log-status").filter({ hasText: "In progress" }).waitFor();
  await seek(page, 2.1); await page.keyboard.press("Shift+I");
  await until(liveBricks, (b) => b.length === 2);
  // N acts on the selected brick — the one just opened — so it waits for the page, not only the database, to hold it.
  await page.locator('[data-testid^="row-brick-"]').nth(1).waitFor();
  const [outer, inner] = await liveBricks();
  await page.keyboard.press("n");
  await page.getByTestId("input-note").fill("  psoas release ");
  await page.getByTestId("input-note").press("Enter");
  await until(liveBricks, (b) => b.some((x) => (x.attributes as { note?: string }).note === "psoas release"));
  await page.getByTestId(`chip-short-${inner.id}`).click();
  await until(liveBricks, (b) => b.some((x) => x.tags.includes("short")));

  // Both bricks are open. Tab selects the outer one without moving the playhead, and O closes it — not the innermost.
  await seek(page, 5.5);
  await page.keyboard.press("Tab");
  assert.ok(Math.abs((await page.evaluate<number>(`${VIDEO}.currentTime`)) - 5.5) < 0.01, "Tab left the playhead where it was");
  await page.keyboard.press("o");
  let saved = await until(liveBricks, (b) => b.some((x) => x.outMs !== null));
  assert.deepEqual(saved.map((b) => [b.id, b.outMs]), [[outer.id, 5600], [inner.id, null]], "O closed the selected outer brick; the inner one is still open");
  await page.keyboard.press("Tab");
  await seek(page, 2.55); await page.keyboard.press("o");
  await until(liveBricks, (b) => b.every((x) => x.outMs !== null));
  await page.keyboard.press("Tab");
  await page.keyboard.press("a");
  await until(liveBricks, (b) => b.some((x) => (x.attributes as { action?: string }).action === "punch_in"));

  // P opens the inner brick on its own: [ moves its in point to the previous word start, Shift+. its out point a frame later.
  await page.keyboard.press("Tab");
  await page.keyboard.press("p");
  await page.getByTestId("brick-editor").waitFor();
  await page.keyboard.press("BracketLeft");
  await until(liveBricks, (b) => b.some((x) => x.inMs === 2000));
  await page.keyboard.press("Shift+Period");
  await until(liveBricks, (b) => b.some((x) => x.outMs === 2633));
  // In the editor Esc undoes the frame and Shift+Esc redoes it, from the logger's own history; D is done.
  await page.keyboard.press("Escape");
  await until(liveBricks, (b) => b.every((x) => x.outMs !== 2633));
  await page.keyboard.press("Shift+Escape");
  await until(liveBricks, (b) => b.some((x) => x.outMs === 2633));
  await page.keyboard.press("d");
  await page.getByTestId("brick-editor").waitFor({ state: "detached" });
  // Back on the logger, Esc undoes the same frame again.
  await page.keyboard.press("Escape");
  saved = await until(liveBricks, (b) => b.every((x) => x.outMs !== 2633));

  assert.deepEqual(saved.map((b) => [b.inMs, b.outMs]), [[1000, 5600], [2000, 2600]]);
  assert.deepEqual(saved.map((b) => (b.attributes as { action: string }).action), ["punch_in", "keep"], "A set the outer brick's action");
  assert.deepEqual(saved[1].tags, ["short"]);
  const events = await db.select().from(cutEvents).where(eq(cutEvents.sourceId, sourceId));
  assert.equal(events.length, 12, "open, open, note, label, close, close, action, two edge moves, undo, redo, undo: one source-owned event each");
  assert.ok(events.every((e) => e.cutId === null), "no cut is involved");

  // Done: the page says so and offers the next step — here the lesson, since the shoot's other file has no transcript.
  await page.getByTestId("button-log-done").click();
  await page.getByTestId("text-log-status").filter({ hasText: "Done" }).waitFor();
  await page.getByTestId("link-open-lesson").waitFor();
  const [{ logDoneAt }] = await db.select({ logDoneAt: sources.logDoneAt }).from(sources).where(eq(sources.id, sourceId));
  assert.ok(logDoneAt, "done is saved");

  await page.reload();
  await page.getByTestId(`chip-short-${inner.id}`).and(page.locator('[aria-pressed="true"]')).waitFor();
  assert.equal(await page.getByTestId(`text-brick-note-${inner.id}`).textContent(), "psoas release");
  assert.equal(await page.getByTestId(`text-brick-action-${outer.id}`).textContent(), "punch in · lower third");
  assert.equal(await page.getByTestId(`text-brick-out-${inner.id}`).textContent(), "0:02:18", "minutes:seconds:frames");
  // Done is not locked: an edit keeps it done; Mark as in progress takes it back.
  await page.getByTestId(`chip-lesson-${inner.id}`).click();
  await until(liveBricks, (b) => b.some((x) => x.tags.includes("lesson")));
  await page.getByTestId("text-log-status").filter({ hasText: "Done" }).waitFor();
  await page.getByTestId("button-log-in-progress").click();
  await page.getByTestId("text-log-status").filter({ hasText: "In progress" }).waitFor();
  await page.getByTestId(`chip-lesson-${inner.id}`).click();
  await until(liveBricks, (b) => !b.some((x) => x.tags.includes("lesson")));
  await page.close();
});

test("the arrows step by word, a second through silence, Shift 5 s and Option a frame; a drag scrubs; J/K/L and Space after J; a tap goes to a brick; Done waits for open bricks; Delete asks first", async () => {
  const page = await viewer(sourceId);
  const time = () => page.evaluate<number>(`${VIDEO}.currentTime`);
  const near = async (want: number, why: string) => { const t = await time(); assert.ok(Math.abs(t - want) < 0.02, `${why} (${t})`); };
  // S shows the action: inside the outer brick, a punch-in at the lower third (set by A in the walkthrough), the
  // picture is framed as the render frames it; outside any punch-in it is the footage as shot. S again turns it off.
  const frame = () => page.evaluate<string>(`${VIDEO}.style.transform`);
  await seek(page, 0.5);
  await page.keyboard.press("s");
  await page.getByTestId("text-showing-action").waitFor();
  assert.equal(await frame(), "", "no punch-in at 0.5 s");
  await seek(page, 3);
  await page.waitForFunction(`${VIDEO}.style.transform === "scale(1.5)"`);
  assert.equal(await page.evaluate<string>(`${VIDEO}.style.transformOrigin`), "50% 100%", "anchored at the bottom: the lower third");
  await page.getByTestId("text-showing-action").filter({ hasText: "punch in, lower third" }).waitFor();
  await page.keyboard.press("s");
  await page.waitForFunction(`${VIDEO}.style.transform === ""`);

  // Words start at 1.0, 1.5, 2.0 and 5.0 s.
  await seek(page, 3);
  await page.keyboard.press("ArrowRight"); await near(5, "→ to the next word, 2 s away");
  await page.keyboard.press("ArrowLeft"); await near(2, "← to the previous word");
  await page.keyboard.press("ArrowLeft"); await near(1.5, "← again");
  await page.keyboard.press("Alt+ArrowRight"); await near(1.533, "Option+→ one frame");
  await page.keyboard.press("Shift+ArrowRight"); await near(6.533, "Shift+→ five seconds");
  await page.keyboard.press("ArrowRight"); await near(7.533, "no word ahead: one second");
  await page.keyboard.press("Shift+ArrowLeft"); await near(2.533, "Shift+← five seconds");

  // Drag from a quarter of the way along the timeline to three quarters: the playhead follows the pointer.
  await page.getByTestId("timeline").scrollIntoViewIfNeeded();
  const box = (await page.getByTestId("timeline").boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height - 6);
  await page.mouse.down();
  assert.ok(Math.abs((await time()) - 2) < 0.1, `pressing seeked to 2 s (${await time()})`);
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height - 6, { steps: 5 });
  await page.mouse.up();
  assert.ok(Math.abs((await time()) - 6) < 0.1, `dragging seeked to 6 s (${await time()})`);

  await page.keyboard.press("j"); await page.keyboard.press("j");
  assert.equal(await page.evaluate<number>(`${VIDEO}.playbackRate`), 0.5, "J twice: half speed");
  await seek(page, 1);
  await page.keyboard.press("Space");
  await page.waitForFunction(`!${VIDEO}.paused`);
  await page.keyboard.press("Space");
  await page.waitForFunction(`${VIDEO}.paused`);
  await page.keyboard.press("l"); await page.keyboard.press("l"); await page.keyboard.press("l");
  assert.equal(await page.evaluate<number>(`${VIDEO}.playbackRate`), 1.25);
  await page.keyboard.press("k");
  assert.equal(await page.evaluate<number>(`${VIDEO}.playbackRate`), 1, "K: back to 1×");

  // A tap on a brick selects it and takes the playhead to its in point.
  const [, inner] = await liveBricks();
  await page.getByTestId(`span-brick-${inner.id}`).dispatchEvent("pointerdown");
  await near(2, "tapping the brick went to its in point");

  await seek(page, 6.5); await page.keyboard.press("i");
  const open = await until(liveBricks, (b) => b.some((x) => x.outMs === null));
  const openId = open.find((x) => x.outMs === null)!.id;
  await page.reload();
  await page.getByTestId("video-log").waitFor();
  await page.waitForFunction(`${VIDEO}?.readyState >= 1`);
  assert.equal(await page.getByTestId(`text-brick-out-${openId}`).textContent(), "open");
  // Done waits until no brick is open, and says which are.
  await page.getByTestId("button-log-done").click();
  await page.getByTestId("text-open-bricks").filter({ hasText: "1 brick is still open" }).waitFor();
  assert.equal((await db.select().from(sources).where(eq(sources.id, sourceId)))[0].logDoneAt, null);

  // Delete asks first: dismissing keeps the brick, accepting removes it.
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.keyboard.press("Delete");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok((await liveBricks()).some((x) => x.id === openId), "dismissed: the brick stays");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.keyboard.press("Delete");
  await until(liveBricks, (b) => !b.some((x) => x.id === openId));
  await page.close();
});

test("the brick editor plays exactly the brick and stops on its last frame; its strip scrubs outside the brick without moving an edge; B and E; I sets the in point at the playhead", async () => {
  const page = await viewer(sourceId);
  const [, inner] = await liveBricks(); // 2.0–2.6 s, from the walkthrough
  await page.getByTestId(`span-brick-${inner.id}`).dispatchEvent("pointerdown");
  await page.keyboard.press("p");
  await page.getByTestId("brick-editor").waitFor();
  const EDITOR = 'document.querySelector("[data-testid=video-editor]")';
  await page.waitForFunction(`${EDITOR}?.readyState >= 2`);
  // S in the editor: this brick's action is keep, so the picture stays as shot, and the editor says so.
  await page.keyboard.press("s");
  await page.getByTestId("text-editor-action").filter({ hasText: "keep (as shot)" }).waitFor();
  assert.equal(await page.evaluate<string>(`${EDITOR}.style.transform`), "");
  await page.keyboard.press("s");
  await page.getByTestId("text-editor-action").waitFor({ state: "detached" });
  const editorTime = () => page.evaluate<number>(`${EDITOR}.currentTime`);
  assert.ok(Math.abs((await editorTime()) - 2) < 0.05, "opened at the in point");
  await page.keyboard.press("Space");
  const times = await page.evaluate<number[]>(`(async () => {
    const v = ${EDITOR}, seen = [], end = performance.now() + 2000;
    while (performance.now() < end) { seen.push(v.currentTime); await new Promise((r) => setTimeout(r, 40)); }
    return seen;
  })()`);
  assert.ok(times.every((t) => t >= 1.95 && t <= 2.6), `played only the brick (${Math.min(...times)}–${Math.max(...times)})`);
  await page.waitForFunction(`${EDITOR}.paused`);
  assert.ok(Math.abs((await editorTime()) - 2.567) < 0.02, `stopped on the brick's last frame (${await editorTime()})`);
  // Space from the last frame starts again at the in point.
  await page.keyboard.press("Space");
  await page.waitForFunction(`!${EDITOR}.paused && ${EDITOR}.currentTime < 2.3`);
  await page.keyboard.press("Space");
  await page.waitForFunction(`${EDITOR}.paused`);

  // David, 2026-10-29: after the out point moved, playback ran past it. Move it 6 frames earlier and play again.
  for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+Comma");
  const moved = (await until(liveBricks, (b) => b.some((x) => x.id === inner.id && Math.abs((x.outMs ?? 0) - 2400) <= 3))).find((x) => x.id === inner.id)!;
  await page.getByTestId("text-editor-span").filter({ hasText: "0:02:12" }).waitFor();
  await page.keyboard.press("b");
  await page.keyboard.press("Space");
  const after = await page.evaluate<number[]>(`(async () => {
    const v = ${EDITOR}, seen = [], end = performance.now() + 1500;
    while (performance.now() < end) { seen.push(v.currentTime); await new Promise((r) => setTimeout(r, 30)); }
    return seen;
  })()`);
  assert.ok(Math.max(...after) <= moved.outMs! / 1000, `stopped at the moved out point, ${moved.outMs} ms (${Math.max(...after)})`);
  await page.waitForFunction(`${EDITOR}.paused`);
  await page.keyboard.press("Escape"); for (let i = 0; i < 5; i++) await page.keyboard.press("Escape");
  await until(liveBricks, (b) => b.some((x) => x.id === inner.id && x.outMs === 2600));

  // ← goes before the brick, into the strip's lead-in, and no edge moves; E goes near the end; B back to the start.
  await page.keyboard.press("b");
  await page.keyboard.press("ArrowLeft");
  assert.ok(Math.abs((await editorTime()) - 1.5) < 0.05, `← went to the word before the brick (${await editorTime()})`);
  await page.getByTestId("text-editor-time").filter({ hasText: "before the brick" }).waitFor();
  assert.equal((await liveBricks()).find((b) => b.id === inner.id)!.inMs, 2000, "scrubbing moved no edge");
  await page.keyboard.press("e");
  assert.ok(Math.abs((await editorTime()) - 2) < 0.05, "E: 2 s before the out point, but never before the in point");
  await page.keyboard.press("b");
  assert.ok(Math.abs((await editorTime()) - 2) < 0.05, "B: the in point");
  // From 1.5 s, I makes the playhead the new in point; the next pass starts there. Esc closes; Esc undoes it.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("i");
  await until(liveBricks, (b) => b.some((x) => x.id === inner.id && x.inMs === 1500));
  await page.getByTestId("text-editor-span").filter({ hasText: "0:01:15" }).waitFor();
  await page.keyboard.press("Escape");
  await until(liveBricks, (b) => b.some((x) => x.id === inner.id && x.inMs === 2000));
  await page.keyboard.press("d");
  await page.getByTestId("brick-editor").waitFor({ state: "detached" });
  // Closed and opened again, the editor's player has a picture (David, 2026-10-29: it went black on reopening).
  await page.keyboard.press("p");
  await page.getByTestId("brick-editor").waitFor();
  await page.waitForFunction(`${EDITOR}?.readyState >= 2 && !${EDITOR}.error`);
  await page.keyboard.press("d");
  await page.close();
});

test("a player whose link has stopped working fetches a fresh one and comes back at the same place", async () => {
  const page = await viewer(sourceId);
  await seek(page, 3.2);
  let signed = 0;
  page.on("request", (r) => { if (r.url().includes(`/sources/${sourceId}/playback`)) signed++; });
  // The link expires: the bucket refuses it, as it does five minutes after it was signed.
  await page.route("http://127.0.0.1:9/expired/**", (route) => route.fulfill({ status: 403, body: "" }));
  await page.evaluate(`(() => { const v = ${VIDEO}; v.src = "http://127.0.0.1:9/expired/proxy.mp4"; v.load(); })()`);
  await page.waitForFunction(`${VIDEO}.src.includes(".mp4") && !${VIDEO}.src.includes("expired") && ${VIDEO}.readyState >= 1`);
  assert.ok(signed >= 1, "a fresh link was asked for");
  await page.waitForFunction(`Math.abs(${VIDEO}.currentTime - 3.2) < 0.05`);
  await page.keyboard.press("Space");
  await page.waitForFunction(`!${VIDEO}.paused`);
  // Report a key problem sends the last key presses and the player's state with the feedback.
  await page.getByTestId("button-report-keys").click();
  await page.getByTestId("text-key-report").filter({ hasText: "Sent" }).waitFor();
  const [report] = await db.select().from(feedback).where(and(eq(feedback.page, `/sources/${sourceId}/log`), eq(feedback.questionKey, "logging-viewer.keys")));
  const state = report.state as { keyLog: Array<{ code: string; outcome: string }>; video: { readyState: number } };
  assert.ok(state.keyLog.some((k) => k.code === "Space" && k.outcome === "playPause") && state.keyLog.some((k) => k.code === "recover"), JSON.stringify(state.keyLog));
  assert.ok(state.video.readyState >= 1);
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
  const [answer] = await db.select().from(feedback).where(and(eq(feedback.page, `/sources/${sourceId}/log`), eq(feedback.questionKey, "logging-viewer.speed")));
  assert.equal(answer.questionKey, "logging-viewer.speed");
  await rail.close();
});
