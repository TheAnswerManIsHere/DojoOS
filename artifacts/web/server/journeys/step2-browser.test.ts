// Step-2 journey through the logging viewer (PLAN_LOGGING_VIEWER.md, the scripted lane), on a playable clip: the
// proxy's signed URL points at the journey's placeholder bucket, and the browser is handed a locally made WebM for it,
// so playback and seeking really run. The walkthrough — a second I or O moving an edge, overlapping bricks in lanes,
// a note and a label, an action, word-step edge moves, undo and redo, a reload — goes through the
// real command route; the arrows and a drag scrub, J/K/L set the speed, Delete asks first; zoom, edge drags, B/E, the
// transcript box and automatic notes; a source with no transcript marks raw time; and the questions render on the page.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { bricks, cutBricks, cutEvents, cuts, derivedKeys, feedback, shoots, sources, transcripts } from "@workspace/shared";
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
      const lessonCuts = (await db.select({ id: cuts.id }).from(cuts).where(eq(cuts.shootId, shootId))).map((c) => c.id);
      if (lessonCuts.length) {
        await db.delete(cutEvents).where(inArray(cutEvents.cutId, lessonCuts));
        await db.delete(cutBricks).where(inArray(cutBricks.cutId, lessonCuts));
        await db.delete(cuts).where(inArray(cuts.id, lessonCuts));
      }
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

test("the walkthrough: a second I moves the open brick's in point and a second O its out point, I after O starts a new brick, overlaps take their own lanes, a note, a label, A, word steps, undo and redo, done, through a reload", async () => {
  const page = await viewer(sourceId);
  await page.getByTestId("text-log-status").filter({ hasText: "Not started" }).waitFor();
  // I opens a brick; I again, while it is open, moves its in point rather than starting another (David, 2026-11-06).
  await seek(page, 1.1); await page.keyboard.press("i");
  let saved = await until(liveBricks, (b) => b.length === 1);
  await page.getByTestId("text-log-status").filter({ hasText: "In progress" }).waitFor();
  await seek(page, 2.1); await page.keyboard.press("i");
  saved = await until(liveBricks, (b) => b.length === 1 && b[0].inMs === 2000);
  // O closes it on a word end; O again moves the out point.
  await seek(page, 2.55); await page.keyboard.press("o");
  saved = await until(liveBricks, (b) => b[0].outMs === 2600);
  await seek(page, 5.5); await page.keyboard.press("o");
  saved = await until(liveBricks, (b) => b.length === 1 && b[0].outMs === 5600);
  const first = saved[0];
  // I after O starts a new brick: one that partly overlaps the first, so it takes the next lane down.
  await seek(page, 1.1); await page.keyboard.press("i");
  await until(liveBricks, (b) => b.length === 2);
  await seek(page, 2.55); await page.keyboard.press("o");
  saved = await until(liveBricks, (b) => b.length === 2 && b.every((x) => x.outMs !== null));
  const second = saved.find((b) => b.id !== first.id)!;
  assert.deepEqual([second.inMs, second.outMs], [1000, 2600]);
  const top = (id: string) => page.getByTestId(`span-brick-${id}`).evaluate((el) => (el as unknown as { style: { top: string } }).style.top);
  assert.notEqual(await top(first.id), await top(second.id), "overlapping bricks sit in different lanes");
  // The note, a label and its colour, on the brick just closed.
  await page.keyboard.press("n");
  await page.getByTestId("input-note").fill("  psoas release ");
  await page.getByTestId("input-note").press("Enter");
  await until(liveBricks, (b) => b.some((x) => (x.attributes as { note?: string }).note === "psoas release"));
  await page.getByTestId(`chip-short-${second.id}`).click();
  await until(liveBricks, (b) => b.find((x) => x.id === second.id)!.tags.includes("short"));
  await page.getByTestId(`span-brick-${second.id}`).and(page.locator(".tag-short")).waitFor();
  // Tap the first brick to pick it: A sets its action, and the word steps move its edges.
  await page.getByTestId(`span-brick-${first.id}`).dispatchEvent("pointerdown");
  await page.keyboard.press("a");
  await until(liveBricks, (b) => (b.find((x) => x.id === first.id)!.attributes as { action: string }).action === "punch_in");
  await page.keyboard.press("BracketLeft");
  await until(liveBricks, (b) => b.find((x) => x.id === first.id)!.inMs === 1500);
  await page.keyboard.press("Shift+Period");
  await until(liveBricks, (b) => b.find((x) => x.id === first.id)!.outMs === 5633);
  await page.keyboard.press("Escape");
  await until(liveBricks, (b) => b.find((x) => x.id === first.id)!.outMs === 5600);
  await page.keyboard.press("Shift+Escape");
  await until(liveBricks, (b) => b.find((x) => x.id === first.id)!.outMs === 5633);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  saved = await until(liveBricks, (b) => b.find((x) => x.id === first.id)!.inMs === 2000 && b.find((x) => x.id === first.id)!.outMs === 5600);
  assert.deepEqual(saved.map((b) => [b.inMs, b.outMs]), [[1000, 2600], [2000, 5600]]);
  const events = await db.select().from(cutEvents).where(eq(cutEvents.sourceId, sourceId));
  assert.ok(events.every((e) => e.cutId === null), "no cut is involved");

  // Done, then a reload shows the same.
  await page.getByTestId("button-log-done").click();
  await page.getByTestId("text-log-status").filter({ hasText: "Done" }).waitFor();
  await page.getByTestId("link-open-lesson").waitFor();
  const [{ logDoneAt }] = await db.select({ logDoneAt: sources.logDoneAt }).from(sources).where(eq(sources.id, sourceId));
  assert.ok(logDoneAt, "done is saved");
  await page.reload();
  await page.getByTestId("video-log").waitFor();
  await page.getByTestId(`chip-short-${second.id}`).and(page.locator('[aria-pressed="true"]')).waitFor();
  assert.equal(await page.getByTestId(`text-brick-note-${second.id}`).textContent(), "psoas release");
  assert.equal(await page.getByTestId(`text-brick-action-${first.id}`).textContent(), "punch in · lower third");
  assert.equal(await page.getByTestId(`text-brick-out-${second.id}`).textContent(), "0:02:18", "minutes:seconds:frames");
  await page.getByTestId("button-log-in-progress").click();
  await page.getByTestId("text-log-status").filter({ hasText: "In progress" }).waitFor();
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
  // A tap on the strip itself lets go of a picked brick, so I starts a new one.
  await page.getByTestId("timeline").click({ position: { x: 2, y: 70 } });

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

test("the strip zooms and scrolls; the selected brick's edges drag to a frame, one undo step each; B and E go to its first and last frame; the transcript box turns pages and a click on a word seeks; automatic note creation", async () => {
  const page = await viewer(sourceId);
  const time = () => page.evaluate<number>(`${VIDEO}.currentTime`);
  const [, brick] = await liveBricks();
  assert.deepEqual([brick.inMs, brick.outMs], [2000, 5600], "the walkthrough's first brick");
  await page.getByTestId(`span-brick-${brick.id}`).dispatchEvent("pointerdown");
  // B and E: the brick's first and last frame.
  await page.keyboard.press("e");
  assert.ok(Math.abs((await time()) - (5.6 - 1 / 30)) < 0.01, `E: the last frame (${await time()})`);
  await page.keyboard.press("b");
  assert.ok(Math.abs((await time()) - 2) < 0.01, "B: the first frame");

  // Zoom: = in around the playhead, the scroll bar appears, \ fits again.
  await page.getByTestId("text-zoom").filter({ hasText: "whole file" }).waitFor();
  await page.keyboard.press("Equal");
  await page.getByTestId("text-zoom").filter({ hasText: "Showing 0:0" }).waitFor();
  await page.getByTestId("timeline-scroll").waitFor();
  await page.keyboard.press("Equal"); await page.keyboard.press("Equal"); await page.keyboard.press("Equal");
  // The deepest zoom is about three seconds across.
  await page.getByTestId("text-zoom").filter({ hasText: /Showing 0:00:\d\d–0:03:\d\d|Showing 0:01:\d\d–0:04:\d\d|Showing 0:00:\d\d–0:02:\d\d/ }).waitFor();
  await page.keyboard.press("Backslash");
  await page.getByTestId("text-zoom").filter({ hasText: "whole file" }).waitFor();
  assert.equal(await page.getByTestId("timeline-scroll").count(), 0, "no scroll bar at fit");

  // Drag the out handle to the middle of the strip (4 s of 8): the edge lands on a frame, in one move.
  await page.getByTestId("timeline").scrollIntoViewIfNeeded();
  const box = (await page.getByTestId("timeline").boundingBox())!;
  const handle = (await page.getByTestId("handle-out").boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, handle.y + handle.height / 2, { steps: 4 });
  await page.mouse.move(box.x + box.width * 0.5, handle.y + handle.height / 2, { steps: 4 });
  await page.mouse.up();
  let saved = await until(liveBricks, (b) => Math.abs(b.find((x) => x.id === brick.id)!.outMs! - 4000) < 40);
  const dragged = saved.find((x) => x.id === brick.id)!.outMs!;
  assert.ok(Math.abs((dragged * 30) / 1000 - Math.round((dragged * 30) / 1000)) < 0.05, `on a frame (${dragged})`);
  await page.keyboard.press("Escape");
  saved = await until(liveBricks, (b) => b.find((x) => x.id === brick.id)!.outMs === 5600);

  // The transcript box: a click on a word moves the playhead to it, paused; the size buttons change its height.
  await page.getByTestId("transcript-strip-words").getByText("Now").click();
  assert.ok(Math.abs((await time()) - 5) < 0.01, "clicked Now: 5 s");
  assert.ok(await page.evaluate<boolean>(`${VIDEO}.paused`), "a click does not start playback");
  await page.getByTestId("transcript-strip-words").locator("span.current").filter({ hasText: "Now" }).waitFor();
  await page.getByTestId("button-transcript-5").click();
  await page.locator(".logging-words.lines-5").waitFor();
  await page.getByTestId("button-transcript-3").click();

  // Automatic note creation: O on a new brick opens the note box at once; Esc closes it with no note.
  await page.getByTestId("input-auto-note").check();
  await page.getByTestId("timeline").click({ position: { x: 2, y: 60 } });
  await seek(page, 6.5); await page.keyboard.press("i");
  await until(liveBricks, (b) => b.some((x) => x.outMs === null));
  await seek(page, 7.5); await page.keyboard.press("Shift+O");
  await page.getByTestId("input-note").waitFor();
  await page.getByTestId("input-note").press("Escape");
  await page.getByTestId("input-note").waitFor({ state: "detached" });
  const made = await until(liveBricks, (b) => b.some((x) => x.inMs === 6500 && x.outMs === 7500));
  assert.ok(!(made.find((x) => x.inMs === 6500)!.attributes as { note?: string }).note, "Esc saved no note");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.keyboard.press("Delete");
  await until(liveBricks, (b) => !b.some((x) => x.inMs === 6500));
  await page.getByTestId("input-auto-note").uncheck();
  await page.close();
});

test("V flips to the Edited view — the bricks with the gaps gone, overlaps once — at the same moment, and back", async () => {
  const page = await viewer(sourceId);
  // Bricks 1.0–2.6 s and 2.0–5.6 s: the edit is 1.0–5.6 s of the file, 4.6 s, starting at the first brick.
  await page.getByTestId("text-view-lengths").filter({ hasText: "0:08:00 → 0:04:18 kept" }).waitFor();
  await seek(page, 3);
  await page.keyboard.press("v");
  await page.getByTestId("lesson-strip").waitFor();
  await page.getByTestId("text-lesson-length").filter({ hasText: "0:04:18" }).waitFor();
  // 3 s of the file plays 2 s into the edit.
  await page.getByTestId("preview").and(page.locator('[data-out-ms="2000"]')).waitFor();
  await page.keyboard.press("ArrowRight");
  await page.getByTestId("preview").and(page.locator('[data-out-ms="4000"]')).waitFor();
  // Back to Original at the footage under the playhead: 4 s into the edit is 5 s of the file.
  await page.keyboard.press("v");
  await page.getByTestId("video-log").waitFor();
  await page.waitForFunction(`${VIDEO}?.readyState >= 1 && Math.abs(${VIDEO}.currentTime - 5) < 0.05`);
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
