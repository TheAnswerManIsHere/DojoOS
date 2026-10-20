// Step-1 journey through the screens (architecture.md §9, step 1: "playback of the proxy through a signed URL"):
// a ready source with a proxy offers Play, and Play puts a short-lived signed URL for the proxy — never the
// original — into a video element. The URL is signed locally against the journey's placeholder bucket, so this
// needs no storage; that the bytes play is the live check on the Repl.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { eq, inArray } from "drizzle-orm";
import { derivedKeys, shoots, sources } from "@workspace/shared";
import { operatorEmail, requireTestDatabase, startServer, type RunningServer } from "./harness";
import { openPage, signInFromPage } from "./browser";

const { db, pool } = requireTestDatabase();
let server: RunningServer;
let browser: Browser;
let shootId: string;
let readyId: string;
let probingId: string;

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
      await db.delete(sources).where(inArray(sources.id, [readyId, probingId].filter(Boolean)));
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
  await ready.getByTestId(`button-play-${readyId}`).click();
  const video = ready.getByTestId(`video-source-${readyId}`);
  await video.waitFor({ state: "attached" });
  const src = new URL((await video.getAttribute("src"))!);
  assert.equal(src.pathname, `/journey/${derivedKeys(readyId).proxy}`, "the proxy's key, path-style in the configured bucket — not the original");
  assert.equal(src.searchParams.get("X-Amz-Expires"), "300", "a five-minute URL");
  assert.ok(src.searchParams.get("X-Amz-Signature"), "signed");
  await page.context().close();
});
