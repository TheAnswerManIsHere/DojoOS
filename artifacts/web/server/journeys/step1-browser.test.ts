// Step-1 journey through the screens (architecture.md §9, step 1: "playback of the proxy through a signed URL"):
// a ready source with a proxy offers Play, and Play puts a short-lived signed URL for the proxy — never the
// original — into a video element. The URL is signed locally against the journey's placeholder bucket, so this
// needs no storage; that the bytes play is the live check on the Repl.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { eq, inArray, sql } from "drizzle-orm";
import { derivedKeys, jobs, shoots, sources, transcripts } from "@workspace/shared";
import { operatorEmail, requireTestDatabase, startServer, type RunningServer } from "./harness";
import { openPage, signInFromPage } from "./browser";

const { db, pool } = requireTestDatabase();
let server: RunningServer;
let browser: Browser;
let shootId: string;
let readyId: string;
let probingId: string;
let failedId: string | undefined;

before(async () => {
  const [shoot] = await db.insert(shoots).values({ name: `Step-1 journey ${Date.now()}` }).returning();
  shootId = shoot.id;
  const [probing] = await db.insert(sources).values({ shootId, role: "camera_a", originalKey: "originals/journey-probing", ingestState: "proxying" }).returning();
  probingId = probing.id;
  const [ready] = await db.insert(sources).values({ shootId, role: "camera_a", originalKey: "originals/journey-ready", ingestState: "ready",
    durationMs: 8000, width: 1280, height: 720, fps: 30 }).returning();
  readyId = ready.id;
  const keys = derivedKeys(readyId);
  await db.update(sources).set({ proxyKey: keys.proxy, spriteKey: keys.sprite, peaksKey: keys.peaks }).where(eq(sources.id, readyId));
  // Two transcripts, so the library shows the newer one.
  await db.insert(transcripts).values({ sourceId: readyId, provider: "assemblyai", version: "universal-2", createdAt: new Date(Date.now() - 60_000),
    words: [{ text: "stale", start_ms: 0, end_ms: 100 }] });
  await db.insert(transcripts).values({ sourceId: readyId, provider: "assemblyai", version: "universal-3-5-pro",
    words: [{ text: "Release", start_ms: 0, end_ms: 400 }, { text: "the", start_ms: 400, end_ms: 520 }, { text: "psoas.", start_ms: 61_000, end_ms: 61_600 }] });
  server = await startServer();
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
    await server?.stop();
  } finally {
    if (shootId) {
      const ids = [readyId, probingId, failedId].filter((id): id is string => !!id);
      await db.delete(transcripts).where(inArray(transcripts.sourceId, ids));
      await db.delete(jobs).where(sql`${jobs.payload}->>'sourceId' in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
      await db.delete(sources).where(inArray(sources.id, ids));
      await db.delete(shoots).where(eq(shoots.id, shootId));
    }
    await pool.end();
  }
});

test("a ready file shows its thumbnail and its camera name, which can be renamed and put back; AI Rename says when it is not set up; the proxy is signed for five minutes", async () => {
  await db.update(sources).set({ originalFileName: "C0001.MP4", name: "C0001.MP4" }).where(eq(sources.id, readyId));
  const page = await openPage(browser);
  await signInFromPage(page, server.origin, operatorEmail);
  const proxying = page.getByTestId(`row-source-${probingId}`);
  await proxying.waitFor();
  assert.match(await proxying.textContent() ?? "", /proxying/i, "the row says it is still proxying");
  assert.equal(await proxying.getByTestId(`thumb-${probingId}`).count(), 0, "no sprite yet, so no thumbnail");
  assert.equal(await proxying.getByTestId(`button-rename-${probingId}`).textContent(), "File 1", "a file with no name is numbered");

  const ready = page.getByTestId(`row-source-${readyId}`);
  await ready.getByTestId(`thumb-${readyId}`).waitFor();
  assert.equal(await ready.getByRole("button", { name: "Play proxy" }).count(), 0, "the library's own player is gone (David, 2026-11-06)");
  await ready.getByTestId(`button-rename-${readyId}`).filter({ hasText: "C0001.MP4" }).click();
  await ready.getByTestId(`input-name-${readyId}`).fill("Psoas release, side-lying");
  await ready.getByTestId(`input-name-${readyId}`).press("Enter");
  await ready.getByTestId(`button-rename-${readyId}`).filter({ hasText: "Psoas release, side-lying" }).waitFor();
  await ready.getByTestId(`text-original-name-${readyId}`).filter({ hasText: "Originally C0001.MP4" }).waitFor();
  assert.equal((await db.select().from(sources).where(eq(sources.id, readyId)))[0].originalFileName, "C0001.MP4", "the original never changes");
  await ready.getByTestId(`button-rename-${readyId}`).click();
  await ready.getByTestId(`button-original-name-${readyId}`).click();
  await ready.getByTestId(`button-rename-${readyId}`).filter({ hasText: "C0001.MP4" }).waitFor();
  // The journey's server has no AI key: the button says so rather than failing silently.
  await ready.getByTestId(`button-ai-rename-${readyId}`).click();
  await ready.getByTestId(`text-name-error-${readyId}`).filter({ hasText: "not set up yet" }).waitFor();

  const src = new URL(await page.evaluate<string>(`fetch("/app-api/sources/${readyId}/playback").then((r) => r.json()).then((b) => b.url)`));
  assert.equal(src.pathname, `/journey/${derivedKeys(readyId).proxy}`, "the proxy's key, path-style in the configured bucket — not the original");
  assert.equal(src.searchParams.get("X-Amz-Expires"), "300", "a five-minute URL");
  assert.ok(src.searchParams.get("X-Amz-Signature"), "signed");
  await page.context().close();
});

test("the library refreshes itself while a source is in ingest, so its new state appears without a reload", async () => {
  const page = await openPage(browser);
  await signInFromPage(page, server.origin, operatorEmail);
  const row = page.getByTestId(`row-source-${probingId}`);
  await row.getByTestId(`text-ingest-state-${probingId}`).filter({ hasText: "proxying" }).waitFor();
  await db.update(sources).set({ ingestState: "ready", proxyKey: derivedKeys(probingId).proxy }).where(eq(sources.id, probingId));
  await row.getByTestId(`text-ingest-state-${probingId}`).filter({ hasText: "ready" }).waitFor({ timeout: 15_000 });
  await page.context().close();
});

test("a failed source shows its error and Process again, which puts it back in ingest", async () => {
  const [failed] = await db.insert(sources).values({ shootId, role: "camera_a", originalKey: "originals/journey-failed", ingestState: "failed" }).returning();
  failedId = failed.id;
  await db.insert(jobs).values({ kind: "source.probe", payload: { sourceId: failedId }, state: "failed", attempts: 3, error: "ffmpeg exited 1: moov atom not found" });
  const page = await openPage(browser);
  await signInFromPage(page, server.origin, operatorEmail);
  const row = page.getByTestId(`row-source-${failedId}`);
  await row.getByTestId(`text-ingest-error-${failedId}`).filter({ hasText: "moov atom not found" }).waitFor();
  await row.getByTestId(`button-retry-ingest-${failedId}`).click();
  await row.getByTestId(`text-ingest-state-${failedId}`).filter({ hasText: "uploaded" }).waitFor();
  assert.equal(await row.getByTestId(`button-retry-ingest-${failedId}`).count(), 0, "no second retry while one is queued");
  await page.context().close();
});

test("a transcribed source shows its newest transcript's word count, and the words with their times on request", async () => {
  const page = await openPage(browser);
  await signInFromPage(page, server.origin, operatorEmail);
  const ready = page.getByTestId(`row-source-${readyId}`);
  const button = ready.getByTestId(`button-transcript-${readyId}`);
  assert.equal(await button.textContent(), "Show transcript (3 words)", "the newest transcript's count, not the stale one's");
  assert.equal(await page.getByTestId(`row-source-${probingId}`).getByRole("button", { name: /transcript/ }).count(), 0, "none until there is one");
  await button.click();
  const text = page.getByTestId(`transcript-${readyId}`);
  await text.waitFor();
  assert.match(await text.textContent() ?? "", /universal-3-5-pro.*\[0:00\] Release the psoas\./s);
  assert.equal(await text.getByText("psoas.").getAttribute("title"), "1:01–1:01", "each word carries its time");
  await page.context().close();
});
