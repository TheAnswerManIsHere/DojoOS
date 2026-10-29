// The library's housekeeping at the server boundary (David's feedback, 2026-10-28): a shoot is archived and brought
// back, never erased; one file is removed, an unfinished upload cancelled with it, and a file still being processed
// is refused; and a running ingest's progress and a running transcription's start reach the page.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray, sql } from "drizzle-orm";
import { jobs, shoots, sources, uploads } from "@workspace/shared";
import { operatorEmail, requireTestDatabase, signInOverHttp, startServer, type RunningServer } from "./harness";

const { db, pool } = requireTestDatabase();
let server: RunningServer;
let cookie: string;
let shootId: string;
const ids: Record<string, string> = {};
type ApiSource = { id: string; ingestProgress: { stage: string; fraction: number | null } | null; transcriptionStartedAt: string | null };
type ApiShoot = { id: string; sources: ApiSource[] };

before(async () => {
  const [shoot] = await db.insert(shoots).values({ name: `Library housekeeping ${Date.now()}` }).returning();
  shootId = shoot.id;
  const add = async (name: string, ingestState: "uploading" | "proxying" | "ready") => {
    const [row] = await db.insert(sources).values({ shootId, role: "camera_a", originalKey: `originals/library-${name}`, ingestState }).returning();
    ids[name] = row.id;
  };
  await add("stalled", "uploading");
  await add("proxying", "proxying");
  await add("transcribing", "ready");
  await db.insert(uploads).values({ sourceId: ids.stalled, uploadId: "journey-multipart" });
  await db.insert(jobs).values({ kind: "source.probe", payload: { sourceId: ids.proxying }, state: "claimed", attempts: 1, claimedAt: new Date(),
    result: { progress: { stage: "proxy", fraction: 0.42 } } });
  await db.insert(jobs).values({ kind: "source.transcribe", payload: { sourceId: ids.transcribing }, state: "claimed", attempts: 1, claimedAt: new Date("2026-10-28T12:00:00Z") });
  server = await startServer();
  cookie = await signInOverHttp(server.origin, operatorEmail);
});

after(async () => {
  try { await server?.stop(); } finally {
    const all = Object.values(ids);
    await db.delete(jobs).where(and(inArray(jobs.kind, ["source.probe", "source.transcribe"]), sql`${jobs.payload}->>'sourceId' in (${sql.join(all.map((id) => sql`${id}`), sql`, `)})`));
    await db.delete(uploads).where(inArray(uploads.sourceId, all));
    await db.delete(sources).where(inArray(sources.id, all));
    await db.delete(shoots).where(eq(shoots.id, shootId));
    await pool.end();
  }
});

const get = async (path: string) => (await (await fetch(`${server.origin}/app-api${path}`, { headers: { cookie } })).json()) as ApiShoot[];
const post = (path: string) => fetch(`${server.origin}/app-api${path}`, { method: "POST", headers: { cookie } });
const ours = (list: ApiShoot[]) => list.find((s) => s.id === shootId);

test("a running ingest reports its stage and how far it is; a running transcription says when it started", async () => {
  const byId = Object.fromEntries(ours(await get("/shoots"))!.sources.map((s) => [s.id, s]));
  assert.deepEqual(byId[ids.proxying].ingestProgress, { stage: "proxy", fraction: 0.42 });
  assert.equal(byId[ids.transcribing].transcriptionStartedAt, "2026-10-28T12:00:00.000Z");
  assert.equal(byId[ids.stalled].ingestProgress, null);
});

test("a file still being processed is refused; an unfinished upload is removed and its multipart upload closed", async () => {
  assert.equal((await post(`/sources/${ids.proxying}/remove`)).status, 409);
  assert.equal((await post(`/sources/${ids.stalled}/remove`)).status, 200);
  const [upload] = await db.select().from(uploads).where(eq(uploads.sourceId, ids.stalled));
  assert.ok(upload.deletedAt, "the upload is closed");
  assert.ok(!ours(await get("/shoots"))!.sources.some((s) => s.id === ids.stalled), "and the file is gone from the library");
  assert.equal((await post(`/sources/${ids.stalled}/remove`)).status, 404, "removing twice finds nothing");
});

test("archiving takes a shoot out of the library and into the archived list; restoring brings it back", async () => {
  assert.equal((await post(`/shoots/${shootId}/archive`)).status, 200);
  assert.equal(ours(await get("/shoots")), undefined);
  assert.ok(ours(await get("/shoots/archived")), "listed as archived");
  assert.equal((await post(`/shoots/${shootId}/archive`)).status, 404, "already archived");
  assert.equal((await post(`/shoots/${shootId}/restore`)).status, 200);
  assert.ok(ours(await get("/shoots")), "back in the library, its files with it");
  assert.equal(ours(await get("/shoots/archived")), undefined);
  assert.equal((await post(`/shoots/${shootId}/restore`)).status, 404, "nothing archived to restore");
});
