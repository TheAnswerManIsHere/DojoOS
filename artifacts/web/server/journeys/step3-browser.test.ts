// Step-3 journey through the lesson timeline (PLAN_LESSON_TIMELINE.md, the scripted lane), on two generated files of
// one shoot whose picture says which file and which second is showing (red or blue, green rising 25 a second) and whose
// tone says which is sounding. The lesson starts with every closed brick in D1's order; Jared moves one brick by
// keyboard and makes a dissolve, which gives the worked example's camera-only shape — three bricks, a 1 s dissolve
// crossing from one file to the other, then a hard cut back. The preview is played through the dissolve and the cut and
// read against the resolved EDL at the same output times — which file each player shows, at what source time, at what
// share of the sound — and its picture is read off screenshots at sought positions, inside the dissolve included.
// Render freezes the lesson: an edit made while the render waits does not change the file the worker makes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { and, eq, inArray, sql } from "drizzle-orm";
import { activeAt, bricks, cutBricks, cutEvents, cuts, derivedKeys, feedback, jobs, revisions, shoots, sources, transcripts, type ResolvedEDL } from "@workspace/shared";
import { requireTestDatabase, startServer, operatorEmail, type RunningServer } from "./harness";
import { openPage, signInFromPage } from "./browser";

const { db, pool } = requireTestDatabase();
const dir = mkdtempSync(join(tmpdir(), "step3-"));
let server: RunningServer;
let browser: Browser;
let shootId: string;
const ids: Record<"A" | "B", string> = { A: "", B: "" };
const files: Record<"A" | "B", string> = { A: join(dir, "a.webm"), B: join(dir, "b.webm") };
const clips: Partial<Record<"A" | "B", Buffer>> = {};
const looks = { A: { red: 200, blue: 0, tone: 440 }, B: { red: 0, blue: 200, tone: 1000 } };

function makeFixture(file: string, which: "A" | "B") {
  const { red, blue, tone } = looks[which];
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
    `color=c=black:s=320x180:r=30:d=10,format=gbrp,geq=r=${red}:g='25*floor(T)':b=${blue}`, "-f", "lavfi", "-i", `sine=frequency=${tone}:duration=10`,
    "-c:v", "libvpx", "-b:v", "400k", "-g", "15", "-c:a", "libopus", "-y", file]);
}
/** The mean colour of an image or a video frame, read by ffmpeg. */
function meanColour(input: Buffer | string, seconds?: number): [number, number, number] {
  const args = ["-hide_banner", "-loglevel", "error", ...(seconds === undefined ? [] : ["-ss", seconds.toFixed(3)]),
    "-i", typeof input === "string" ? input : "pipe:0", "-frames:v", "1", "-vf", "scale=8:8:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"];
  const raw = execFileSync("ffmpeg", args, typeof input === "string" ? {} : { input });
  const sum = [0, 0, 0];
  for (let i = 0; i < raw.length; i += 3) for (let c = 0; c < 3; c++) sum[c] += raw[i + c];
  return sum.map((v) => v / (raw.length / 3)) as [number, number, number];
}

before(async () => {
  makeFixture(files.A, "A");
  makeFixture(files.B, "B");
  clips.A = readFileSync(files.A); clips.B = readFileSync(files.B);
  const [shoot] = await db.insert(shoots).values({ name: `Step-3 journey ${Date.now()}` }).returning();
  shootId = shoot.id;
  for (const [n, which] of (["A", "B"] as const).entries()) {
    const [row] = await db.insert(sources).values({ shootId, role: "camera_a", originalKey: `originals/journey-step3-${which}`, ingestState: "ready",
      durationMs: 10_000, width: 320, height: 180, fps: 30, createdAt: new Date(Date.now() - 60_000 + n * 1000) }).returning();
    ids[which] = row.id;
    await db.update(sources).set({ proxyKey: derivedKeys(row.id).proxy }).where(eq(sources.id, row.id));
    // One word a second, so a word step on the lesson page's edge keys is a one-second trim.
    await db.insert(transcripts).values({ sourceId: row.id, provider: "elevenlabs", version: "scribe_v2",
      words: Array.from({ length: 9 }, (_, k) => ({ text: `w${k}`, start_ms: k * 1000, end_ms: k * 1000 + 1000 })) });
  }
  // Logged out of order on purpose: file A's two bricks come first in D1's order, file B's after them.
  await db.insert(bricks).values([
    { id: `${shootId}b1`, sourceId: ids.A, inMs: 0, outMs: 3000, attributes: { action: "punch_in", preset: "upper third" } }, { id: `${shootId}b2`, sourceId: ids.B, inMs: 1000, outMs: 5000 },
    { id: `${shootId}b3`, sourceId: ids.A, inMs: 5000, outMs: 7000 }, { id: `${shootId}open`, sourceId: ids.A, inMs: 8000, outMs: null },
  ]);
  server = await startServer();
  browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
});

after(async () => {
  try {
    await browser?.close();
    await server?.stop();
  } finally {
    if (shootId) {
      const lessonCuts = (await db.select({ id: cuts.id }).from(cuts).where(eq(cuts.shootId, shootId))).map((c) => c.id);
      if (lessonCuts.length) {
        const revs = (await db.select({ id: revisions.id }).from(revisions).where(inArray(revisions.cutId, lessonCuts))).map((r) => r.id);
        if (revs.length) await db.delete(jobs).where(inArray(sql`${jobs.payload}->>'revisionId'`, revs));
        await db.delete(revisions).where(inArray(revisions.cutId, lessonCuts));
        await db.delete(cutEvents).where(inArray(cutEvents.cutId, lessonCuts));
        await db.delete(cutBricks).where(inArray(cutBricks.cutId, lessonCuts));
        await db.delete(cuts).where(inArray(cuts.id, lessonCuts));
      }
      await db.delete(feedback).where(eq(feedback.page, `/shoots/${shootId}/lesson`));
      await db.delete(cutEvents).where(inArray(cutEvents.sourceId, Object.values(ids).filter(Boolean)));
      await db.delete(bricks).where(inArray(bricks.sourceId, Object.values(ids).filter(Boolean)));
      await db.delete(transcripts).where(inArray(transcripts.sourceId, Object.values(ids).filter(Boolean)));
      await db.delete(sources).where(inArray(sources.id, Object.values(ids).filter(Boolean)));
      await db.delete(shoots).where(eq(shoots.id, shootId));
    }
    await pool.end();
  }
});

/** The lesson page, with each proxy request answered by byte range from that file's fixture, as the bucket does. */
async function lessonPage(): Promise<Page> {
  const page = await openPage(browser);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = route.request().url();
    const which = url.includes(ids.A) ? "A" : url.includes(ids.B) ? "B" : null;
    if (!which || !url.includes(".mp4")) return route.fulfill({ status: 404, body: "" });
    const clip = clips[which]!;
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? "");
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : clip.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: "video/webm", body: clip.subarray(start, end + 1),
      headers: { "accept-ranges": "bytes", ...(range && { "content-range": `bytes ${start}-${end}/${clip.length}` }) } });
  });
  await signInFromPage(page, server.origin, operatorEmail);
  await page.getByTestId(`link-lesson-${shootId}`).click();
  await page.getByTestId("strip").waitFor();
  return page;
}
const lessonCut = async () => (await db.select().from(cuts).where(eq(cuts.shootId, shootId)))[0];
const order = async () => (await db.select().from(cutBricks).where(and(eq(cutBricks.cutId, (await lessonCut()).id), sql`${cutBricks.deletedAt} is null`))
  .orderBy(cutBricks.position)).map((r) => ({ brick: r.brickId.slice(shootId.length), transition: r.overrides.transition }));
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for the saved state");
}
const resolvedEdl = async (page: Page) => (await page.evaluate<{ resolved: ResolvedEDL }>(`fetch("/app-api/shoots/${shootId}/lesson").then((r) => r.json())`)).resolved;
/** Every player's state and the output clock, read in one pass. */
const players = (page: Page) => page.evaluate<{ outMs: number; videos: Array<{ sourceId: string; ms: number; volume: number; opacity: number; paused: boolean }> }>(`(() => {
  const preview = document.querySelector("[data-testid=preview]");
  return { outMs: Number(preview.dataset.outMs), videos: [...preview.querySelectorAll("video")].map((v) => ({ sourceId: v.dataset.sourceId ?? "",
    ms: v.currentTime * 1000, volume: v.volume, opacity: Number(v.style.opacity || 0), paused: v.paused })) };
})()`);
const settled = (page: Page) => page.waitForFunction(`[...document.querySelectorAll("[data-testid=preview] video")]
  .every((v) => Number(v.style.opacity || 0) === 0 || (v.readyState >= 2 && !v.seeking))`);

test("the lesson starts with every closed brick in D1's order; a move and a dissolve by keyboard give the worked example's shape", async () => {
  const page = await lessonPage();
  assert.deepEqual(await order(), [{ brick: "b1", transition: "cut" }, { brick: "b3", transition: "cut" }, { brick: "b2", transition: "cut" }],
    "file A's bricks first by in point, then file B's; the open brick is left out");
  await page.getByTestId("text-lesson-length").filter({ hasText: "0:09:00" }).waitFor();
  // The arrows are the player's, as on every player: → steps to the lesson's next word (one a second here), Option a frame.
  await page.keyboard.press("ArrowRight");
  await page.getByTestId("preview").and(page.locator('[data-out-ms="1000"]')).waitFor();
  await page.keyboard.press("Alt+ArrowRight");
  await page.getByTestId("preview").and(page.locator('[data-out-ms="1033"]')).waitFor();
  await page.keyboard.press("Shift+ArrowLeft");
  await page.getByTestId("preview").and(page.locator('[data-out-ms="0"]')).waitFor();
  // Tab selects (the arrows are the player's, as on every player); - moves the selected brick earlier.
  await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
  await page.keyboard.press("Minus");
  await until(order, (o) => o[1].brick === "b2");
  await page.keyboard.press("Shift+Tab"); // the moved brick stays selected; Shift+Tab goes to the first
  await page.keyboard.press("d");
  await until(order, (o) => o[0].transition === "dissolve");
  assert.deepEqual((await order()).map((o) => o.brick), ["b1", "b2", "b3"]);
  await page.getByTestId("text-lesson-length").filter({ hasText: "0:08:00" }).waitFor();
  // Bricks keep their numbers whatever the order: b2 is Brick 2 though it now plays second.
  const tileName = async (brick: string) => {
    const entry = (await db.select().from(cutBricks).where(and(eq(cutBricks.cutId, (await lessonCut()).id), eq(cutBricks.brickId, `${shootId}${brick}`))))[0];
    return page.getByTestId(`text-tile-name-${entry.id}`).textContent();
  };
  assert.deepEqual([await tileName("b1"), await tileName("b2"), await tileName("b3")], ["Brick 1", "Brick 2", "Brick 3"]);
  // P opens the selected brick in the brick editor, the logger's own: , moves its out point to the previous word's end,
  // a second earlier with this footage's one word a second, and the lesson is a second shorter. Esc undoes it; D closes.
  await page.keyboard.press("p");
  await page.getByTestId("brick-editor").waitFor();
  await page.keyboard.press("Comma");
  await page.getByTestId("text-lesson-length").filter({ hasText: "0:07:00" }).waitFor();
  assert.deepEqual((await db.select().from(bricks).where(eq(bricks.id, `${shootId}b1`))).map((b) => [b.inMs, b.outMs]), [[0, 2000]], "the brick itself moved");
  await page.keyboard.press("Escape");
  await page.getByTestId("text-lesson-length").filter({ hasText: "0:08:00" }).waitFor();
  await page.keyboard.press("d");
  await page.getByTestId("brick-editor").waitFor({ state: "detached" });
  const [b1] = await db.select().from(bricks).where(eq(bricks.id, `${shootId}b1`));
  assert.deepEqual([b1.inMs, b1.outMs], [0, 3000]);
  const events = await db.select().from(cutEvents).where(eq(cutEvents.cutId, (await lessonCut()).id));
  assert.equal(events.length, 2, "move and transition: one cut-owned event each; the brick's edits are its file's");
  assert.ok(events.every((e) => e.sourceId === null));

  // A tile dragged with the mouse moves its brick: Brick 3 dragged before Brick 1 plays first. Esc undoes the move.
  const tileOf = async (brick: string) => {
    const entry = (await db.select().from(cutBricks).where(and(eq(cutBricks.cutId, (await lessonCut()).id), eq(cutBricks.brickId, `${shootId}${brick}`))))[0];
    return page.getByTestId(`tile-${entry.id}`);
  };
  await (await tileOf("b3")).scrollIntoViewIfNeeded();
  const from = (await (await tileOf("b3")).boundingBox())!, to = (await (await tileOf("b1")).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await until(order, (o) => o[0].brick === "b3");
  await page.keyboard.press("Escape");
  await until(order, (o) => o.map((x) => x.brick).join() === "b1,b2,b3");
  await page.close();
});

test("the preview plays through the dissolve and the cut showing and sounding what the resolved EDL says, seeking into the dissolve included", async () => {
  const page = await lessonPage();
  const edl = await resolvedEdl(page);
  // b1 0–3 s on file A, a 1 s dissolve into b2 (file B, 1–5 s) at 2–3 s, a hard cut at 6 s to b3 (file A, 5–7 s): 8 s.
  assert.deepEqual(edl.picture.map((p) => [p.outStartMs, p.outEndMs]), [[0, 3000], [2000, 6000], [6000, 8000]]);
  const source = (sourceId: string) => (sourceId === ids.A ? "A" : "B");

  // Picture, read off the screen at sought positions: file A alone, the middle of the dissolve, file B, across the cut.
  for (const [at, want] of [[1500, { red: 200, blue: 0 }], [2500, { red: 100, blue: 100 }], [4500, { red: 0, blue: 200 }], [6500, { red: 200, blue: 0 }]] as const) {
    await page.getByTestId("input-preview-seek").fill(String(at));
    await page.getByTestId("preview").and(page.locator(`[data-out-ms="${at}"]`)).waitFor();
    await settled(page);
    await page.waitForTimeout(150);
    const [r, , b] = meanColour(await page.getByTestId("preview").screenshot());
    assert.ok(Math.abs(r - want.red) < 40 && Math.abs(b - want.blue) < 40, `picture at ${at} ms: saw red ${Math.round(r)}, blue ${Math.round(b)}`);
    const state = await players(page);
    for (const a of activeAt(edl, at)) {
      const v = state.videos.find((x) => x.sourceId === a.sourceId && x.opacity > 0);
      assert.ok(v && Math.abs(v.ms - a.sourceMs) < 200, `at ${at} ms file ${source(a.sourceId)} is cued at ${a.sourceMs} ms (${JSON.stringify(state.videos)})`);
    }
  }

  // The lesson plays each brick's action: b1 is a punch-in at the upper third, framed as the render frames it, and b2 is
  // as shot. S turns actions off, and on again.
  await page.getByTestId("input-preview-seek").fill("1000");
  await settled(page);
  const transforms = () => page.evaluate<Record<string, string>>(`Object.fromEntries([...document.querySelectorAll("[data-testid=preview] video")]
    .filter((v) => Number(v.style.opacity || 0) > 0).map((v) => [v.dataset.sourceId, v.style.transform + " @ " + v.style.transformOrigin]))`);
  assert.equal((await transforms())[ids.A], "scale(1.5) @ 50% 0%", "b1 framed at the top");
  await page.getByTestId(`text-lesson-actions`).filter({ hasText: "punch in, upper third" }).waitFor();
  await page.keyboard.press("s");
  await page.waitForFunction(`[...document.querySelectorAll("[data-testid=preview] video")].every((v) => v.style.transform === "")`);
  await page.getByTestId("text-lesson-actions").filter({ hasText: "as shot" }).waitFor();
  await page.keyboard.press("s");
  await page.getByTestId("input-preview-seek").fill("4500");
  await settled(page);
  assert.equal((await transforms())[ids.B], " @ ", "b2, a keep, as shot");

  // Sound and source time while it plays, from 1.5 s on through the dissolve and the cut.
  await page.getByTestId("input-preview-seek").fill("1500");
  await settled(page);
  await page.getByTestId("strip").click({ position: { x: 1, y: 1 } }).catch(() => {});
  await page.getByTestId("input-preview-seek").fill("1500");
  await settled(page);
  await page.locator("body").press("Space");
  const startedAt = await players(page);
  assert.ok(startedAt.outMs < 2000, `Space played from the playhead at 1.5 s (${startedAt.outMs})`);
  const samples: Array<Awaited<ReturnType<typeof players>>> = [];
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const s = await players(page);
    samples.push(s);
    if (s.outMs >= 7200) break;
    await page.waitForTimeout(60);
  }
  const playedThrough = samples.filter((s) => s.outMs > 1600 && s.outMs < 7200);
  assert.ok(playedThrough.some((s) => s.outMs > 2100 && s.outMs < 2900), "sampled inside the dissolve");
  assert.ok(playedThrough.some((s) => s.outMs > 5600 && s.outMs < 6000) && playedThrough.some((s) => s.outMs > 6000 && s.outMs < 6400), "sampled either side of the cut");
  assert.ok(samples.at(-1)!.outMs >= 7200, `played on past the cut (${samples.at(-1)!.outMs})`);
  for (const s of playedThrough) {
    // Skip the instants a player hands over (within a frame or two of a boundary), where the read is between frames.
    if ([2000, 3000, 6000].some((b) => Math.abs(s.outMs - b) < 80)) continue;
    const active = activeAt(edl, s.outMs);
    for (const a of active) {
      const v = s.videos.find((x) => x.sourceId === a.sourceId && !x.paused && x.volume > 0);
      assert.ok(v, `at ${Math.round(s.outMs)} ms file ${source(a.sourceId)} is playing (${JSON.stringify(s.videos)})`);
      assert.ok(Math.abs(v.volume - a.weight) < 0.2, `at ${Math.round(s.outMs)} ms file ${source(a.sourceId)} sounds at ${v.volume.toFixed(2)}, the EDL says ${a.weight.toFixed(2)}`);
      assert.ok(Math.abs(v.ms - a.sourceMs) < 250, `at ${Math.round(s.outMs)} ms file ${source(a.sourceId)} is at ${Math.round(v.ms)} ms, the EDL says ${a.sourceMs}`);
    }
    const audible = s.videos.filter((x) => !x.paused && x.volume > 0.15).map((x) => x.sourceId);
    assert.ok(audible.every((id) => active.some((a) => a.sourceId === id)), `nothing else sounds at ${Math.round(s.outMs)} ms`);
  }
  await page.close();
});

test("Render freezes the lesson: an edit made while the render waits does not change what the worker renders", async () => {
  const page = await lessonPage();
  await page.keyboard.press("r");
  await page.getByTestId("text-render-state-1").filter({ hasText: "queued" }).waitFor();
  const cut = await lessonCut();
  const [revision] = await db.select().from(revisions).where(eq(revisions.cutId, cut.id));
  const [job] = await db.select().from(jobs).where(sql`${jobs.payload}->>'revisionId' = ${revision.id}`);
  assert.equal(job.kind, "cut.render");
  // While it waits, b2's transition becomes a dissolve: the lesson is now 7 s and dissolves into b3 at 5–6 s.
  await page.keyboard.press("Tab");
  await page.keyboard.press("d");
  await until(order, (o) => o[1].transition === "dissolve");
  await page.getByTestId("text-lesson-length").filter({ hasText: "0:07:00" }).waitFor();
  await page.close();

  // The worker's render, run here on the same row, with storage on local files.
  const out = join(dir, "rendered.mp4");
  const { renderRevision } = await import(new URL("../../../worker/src/render.ts", import.meta.url).href) as typeof import("../../../worker/src/render");
  await renderRevision(db, {
    download: async (key, file) => copyFileSync(key.endsWith("-A") ? files.A : files.B, file),
    put: async (_key, file) => copyFileSync(file, out),
  }, revision.id, new AbortController().signal);
  const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]).toString());
  assert.ok(Math.abs(seconds - 8) < 0.05, `the render is the frozen 8 s lesson, not the edited 7 s one (${seconds} s)`);
  const [r, , b] = meanColour(out, 5.5);
  assert.ok(b > 160 && r < 40, `at 5.5 s it shows file B alone, with no dissolve into file A (red ${Math.round(r)}, blue ${Math.round(b)})`);
  const [rendered] = await db.select().from(revisions).where(eq(revisions.id, revision.id));
  assert.equal(rendered.renderKey, `renders/${revision.id}.mp4`);
});
