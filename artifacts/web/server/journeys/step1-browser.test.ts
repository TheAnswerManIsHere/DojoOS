// Step-1 journey through the screens (architecture.md §9, step 1: "playback of the proxy through a signed URL"):
// a ready source with a proxy offers Play, and Play puts a short-lived signed URL for the proxy — never the
// original — into a video element. The URL is signed locally against the journey's placeholder bucket, so this
// needs no storage; that the bytes play is the live check on the Repl.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { eq, inArray, sql } from "drizzle-orm";
import { derivedKeys, jobs, shoots, sources } from "@workspace/shared";
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
      await db.delete(jobs).where(sql`${jobs.payload}->>'sourceId' in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
      await db.delete(sources).where(inArray(sources.id, ids));
      await db.delete(shoots).where(eq(shoots.id, shootId));
    }
    await pool.end();
  }
});

test("a ready source plays its proxy through a signed URL; a source still proxying offers nothing to play", async () => {
  const page = await openPage(browser);
  await signInFromPage(page, server.origin, operatorEmail);
  const proxying = page.getByTestId(`row-source-${probingId}`);
  await proxying.waitFor();
  assert.equal(await proxying.getByRole("button", { name: "Play proxy" }).count(), 0);
  assert.match(await proxying.textContent() ?? "", /proxying/);

  const ready = page.getByTestId(`row-source-${readyId}`);
  const playback = page.waitForResponse((r) => r.url().endsWith(`/app-api/sources/${readyId}/playback`));
  await ready.getByTestId(`button-play-${readyId}`).click();
  const src = new URL(((await (await playback).json()) as { url: string }).url);
  assert.equal(src.pathname, `/journey/${derivedKeys(readyId).proxy}`, "the proxy's key, path-style in the configured bucket — not the original");
  assert.equal(src.searchParams.get("X-Amz-Expires"), "300", "a five-minute URL");
  assert.ok(src.searchParams.get("X-Amz-Signature"), "signed");
  await page.context().close();
});

test("when playback cannot continue the player says so and offers Play again, after exactly one automatic refresh", async () => {
  // The journey's bucket is unreachable, so every load fails: the first failure fetches a fresh URL once, the second ends.
  const page = await openPage(browser);
  await signInFromPage(page, server.origin, operatorEmail);
  let fetches = 0;
  page.on("response", (r) => { if (r.url().endsWith(`/app-api/sources/${readyId}/playback`)) fetches++; });
  const ready = page.getByTestId(`row-source-${readyId}`);
  await ready.getByTestId(`button-play-${readyId}`).click();
  await ready.getByText("The proxy could not be played. Press Play to try again.").waitFor();
  await ready.getByTestId(`button-play-${readyId}`).waitFor();
  assert.equal(fetches, 2, "the user's fetch and one automatic refresh");
  await page.context().close();
});

test("the library refreshes itself while a source is in ingest, so Play appears without a reload", async () => {
  const page = await openPage(browser);
  await signInFromPage(page, server.origin, operatorEmail);
  const row = page.getByTestId(`row-source-${probingId}`);
  await row.getByTestId(`text-ingest-state-${probingId}`).filter({ hasText: "proxying" }).waitFor();
  await db.update(sources).set({ ingestState: "ready", proxyKey: derivedKeys(probingId).proxy }).where(eq(sources.id, probingId));
  await row.getByTestId(`button-play-${probingId}`).waitFor({ timeout: 15_000 });
  await row.getByTestId(`text-ingest-state-${probingId}`).filter({ hasText: "ready" }).waitFor();
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
