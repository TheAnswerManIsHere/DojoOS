// Step-1 recovery at the server boundary (architecture.md §2 operations: "failed with the error text … the operator
// retries from the page"): what the library reports for each source, and the retry route's guard.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray, sql } from "drizzle-orm";
import { derivedKeys, jobs, shoots, sources } from "@workspace/shared";
import { operatorEmail, requireTestDatabase, signInOverHttp, startServer, type RunningServer } from "./harness";

const { db, pool } = requireTestDatabase();
let server: RunningServer;
let cookie: string;
let shootId: string;
const ids: Record<string, string> = {};
type ApiSource = { id: string; ingestState: string; hasProxy: boolean; lastError: string | null; retryable: boolean };

before(async () => {
  const [shoot] = await db.insert(shoots).values({ name: `Step-1 recovery ${Date.now()}` }).returning();
  shootId = shoot.id;
  const add = async (name: string, ingestState: "failed" | "ready", proxy: boolean) => {
    const [row] = await db.insert(sources).values({ shootId, role: "camera_a", originalKey: `originals/${name}`, ingestState }).returning();
    if (proxy) await db.update(sources).set({ proxyKey: derivedKeys(row.id).proxy }).where(eq(sources.id, row.id));
    ids[name] = row.id;
  };
  await add("failed", "failed", false);
  await add("legacy", "ready", false);
  await add("done", "ready", true);
  await add("retrying", "failed", false);
  await db.insert(jobs).values({ kind: "source.probe", payload: { sourceId: ids.failed }, state: "failed", attempts: 3, error: "ffmpeg exited 1: invalid data" });
  await db.insert(jobs).values({ kind: "source.probe", payload: { sourceId: ids.retrying }, state: "queued", attempts: 1, error: "transient" });
  server = await startServer();
  cookie = await signInOverHttp(server.origin, operatorEmail);
});

after(async () => {
  try { await server?.stop(); } finally {
    const all = Object.values(ids);
    await db.delete(jobs).where(and(eq(jobs.kind, "source.probe"), sql`${jobs.payload}->>'sourceId' in (${sql.join(all.map((id) => sql`${id}`), sql`, `)})`));
    await db.delete(sources).where(inArray(sources.id, all));
    await db.delete(shoots).where(eq(shoots.id, shootId));
    await pool.end();
  }
});

async function listed() {
  const shootsList = (await (await fetch(`${server.origin}/app-api/shoots`, { headers: { cookie } })).json()) as Array<{ id: string; sources: ApiSource[] }>;
  return Object.fromEntries(shootsList.find((s) => s.id === shootId)!.sources.map((s) => [s.id, s]));
}
const retry = (id: string) => fetch(`${server.origin}/app-api/sources/${id}/retry`, { method: "POST", headers: { cookie } });

test("the library reports a failed source's error, and which sources can be processed again", async () => {
  const byId = await listed();
  assert.deepEqual([byId[ids.failed].lastError, byId[ids.failed].retryable], ["ffmpeg exited 1: invalid data", true]);
  assert.deepEqual([byId[ids.legacy].lastError, byId[ids.legacy].retryable], [null, true], "ready before ingest made a proxy");
  assert.equal(byId[ids.done].retryable, false, "already has its proxy");
  assert.equal(byId[ids.retrying].retryable, false, "an attempt is already queued");
});

test("retry queues one ingest for a failed source, and refuses a second while it is queued", async () => {
  const first = await retry(ids.failed);
  assert.equal(first.status, 202);
  assert.equal(((await first.json()) as ApiSource).ingestState, "uploaded");
  const queued = await db.select().from(jobs).where(and(eq(jobs.state, "queued"), sql`${jobs.payload}->>'sourceId' = ${ids.failed}`));
  assert.equal(queued.length, 1);
  assert.equal((await retry(ids.failed)).status, 409);
});

test("retry brings a source marked ready before ingest made a proxy back through ingest", async () => {
  assert.equal((await retry(ids.legacy)).status, 202);
  const [row] = await db.select().from(sources).where(eq(sources.id, ids.legacy));
  assert.equal(row.ingestState, "uploaded");
});

test("retry refuses a source that already has its proxy, one with an attempt queued, and one that does not exist", async () => {
  assert.equal((await retry(ids.done)).status, 409);
  assert.equal((await retry(ids.retrying)).status, 409);
  assert.equal((await retry("01NOTAREALSOURCE0000000000")).status, 409);
});
