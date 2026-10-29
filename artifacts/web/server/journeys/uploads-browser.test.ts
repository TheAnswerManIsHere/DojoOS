// The uploader in the browser (David's feedback, 2026-10-28): one place to choose a file; a dropped part is tried again
// on its own; an upload stopped part-way says how far it got and continues when the same file is chosen again, sending
// only the parts still missing; and an unfinished upload can be discarded. The bucket is not reachable from a journey,
// so the browser's calls to start, sign and complete an upload, and its part uploads, are answered here; removing the
// discarded upload goes through the real route.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Route } from "playwright";
import { eq, inArray } from "drizzle-orm";
import { shoots, sources, uploads } from "@workspace/shared";
import { operatorEmail, requireTestDatabase, startServer, type RunningServer } from "./harness";
import { openPage, signInFromPage } from "./browser";

const { db, pool } = requireTestDatabase();
let server: RunningServer;
let browser: Browser;
let shootId: string;
const ids: string[] = [];
let dir: string;

before(async () => {
  const [shoot] = await db.insert(shoots).values({ name: `Uploader journey ${Date.now()}` }).returning();
  shootId = shoot.id;
  for (const name of ["first", "second"]) {
    const [row] = await db.insert(sources).values({ shootId, role: "camera_a", originalKey: `originals/uploader-${name}` }).returning();
    ids.push(row.id);
    await db.insert(uploads).values({ sourceId: row.id, uploadId: `multipart-${name}` });
  }
  dir = mkdtempSync(join(tmpdir(), "uploader-"));
  writeFileSync(join(dir, "lesson-camera-a.mp4"), Buffer.alloc(17 * 1024 * 1024)); // three 8 MB parts
  writeFileSync(join(dir, "another.mp4"), Buffer.alloc(1024));
  server = await startServer();
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
    await server?.stop();
  } finally {
    await db.delete(uploads).where(inArray(uploads.sourceId, ids));
    await db.delete(sources).where(inArray(sources.id, ids));
    await db.delete(shoots).where(eq(shoots.id, shootId));
    await pool.end();
  }
});

test("a dropped part is retried, a stopped upload continues from the same file with only its missing parts, and an unfinished one can be discarded", async () => {
  const page = await openPage(browser);
  const starts: string[] = [];
  const puts: string[] = [];
  const hung: Route[] = [];
  let completed: { partNumber: number; etag: string }[] = [];
  let dropOnce = true;
  await page.route(`${server.origin}/app-api/uploads`, async (route) => {
    const { fileName } = route.request().postDataJSON() as { fileName: string };
    starts.push(fileName);
    const id = ids[starts.length - 1];
    await route.fulfill({ status: 201, json: { id, uploadId: `multipart-${starts.length === 1 ? "first" : "second"}` } });
  });
  await page.route(`${server.origin}/app-api/uploads/*/parts`, (route) => {
    const id = route.request().url().split("/").at(-2);
    const { partNumber } = route.request().postDataJSON() as { partNumber: number };
    return route.fulfill({ json: { url: `http://127.0.0.1:9/${id}/part/${partNumber}` } });
  });
  await page.route(`${server.origin}/app-api/uploads/*/complete`, async (route) => {
    completed = (route.request().postDataJSON() as { parts: typeof completed }).parts;
    await db.update(sources).set({ ingestState: "uploaded" }).where(eq(sources.id, ids[0]));
    await route.fulfill({ json: {} });
  });
  await page.route("http://127.0.0.1:9/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "PUT", "access-control-allow-headers": "*" } });
    puts.push(path);
    if (path === `/${ids[0]}/part/2` && dropOnce) { dropOnce = false; return route.abort("connectionreset"); }
    // The first file's last part, and every part of the second file, never answer: the upload is left part-way.
    if ((path === `/${ids[0]}/part/3` && puts.filter((p) => p === path).length === 1) || path.startsWith(`/${ids[1]}/`)) { hung.push(route); return; }
    return route.fulfill({ status: 200, headers: { etag: `"etag-${path.split("/").at(-1)}"`, "access-control-expose-headers": "ETag", "access-control-allow-origin": "*" }, body: "" });
  });
  await signInFromPage(page, server.origin, operatorEmail);
  const input = page.getByTestId(`input-source-file-${shootId}`);
  await input.setInputFiles(join(dir, "lesson-camera-a.mp4"));
  await page.getByText("Part 2 of 3 didn’t go through; trying again…").waitFor();
  for (let i = 0; i < 100 && !puts.includes(`/${ids[0]}/part/3`); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(puts, [`/${ids[0]}/part/1`, `/${ids[0]}/part/2`, `/${ids[0]}/part/2`, `/${ids[0]}/part/3`], "part 2 was tried again on its own");

  // The page goes away mid-part. Back on it, the upload says how far it got.
  await page.reload();
  const row = page.getByTestId(`row-pending-upload-${ids[0]}`);
  await row.getByText("Stopped at part 2 of 3.").waitFor();
  await row.getByText("Camera A").waitFor();

  // The same file, chosen in the one place there is: the upload continues, sending part 3 alone, and completes.
  await input.setInputFiles(join(dir, "lesson-camera-a.mp4"));
  await page.getByText("lesson-camera-a.mp4 is uploaded.", { exact: false }).waitFor();
  assert.deepEqual(starts, ["lesson-camera-a.mp4"], "no second upload was started");
  assert.deepEqual(puts.slice(4), [`/${ids[0]}/part/3`]);
  assert.deepEqual(completed.map((p) => p.partNumber), [1, 2, 3]);
  await row.waitFor({ state: "detached" });

  // Any other file starts a new upload; left unfinished, it can be discarded, which removes it from the shoot.
  await page.locator(`[data-testid="input-source-file-${shootId}"]:not([disabled])`).waitFor({ state: "attached" });
  await input.setInputFiles(join(dir, "another.mp4"));
  for (let i = 0; i < 100 && !hung.some((r) => r.request().url().includes(ids[1])); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(starts, ["lesson-camera-a.mp4", "another.mp4"]);
  await page.reload();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByTestId(`button-discard-upload-${ids[1]}`).click();
  await page.getByTestId(`row-pending-upload-${ids[1]}`).waitFor({ state: "detached" });
  const [discarded] = await db.select().from(sources).where(eq(sources.id, ids[1]));
  assert.ok(discarded.deletedAt, "the discarded upload's file is removed");
  await page.close();
});
