import { eq, and, isNull } from "drizzle-orm";
import { connectDb, createQueue, createStorage, jobs, jobLeaseMs } from "@workspace/shared";
import type { SourceProbePayload } from "@workspace/shared";
import { createServer } from "node:http";
import { DrainRunner } from "./runner";
import { ingest } from "./ingest";

const concurrency = Number(process.env.WORKER_CONCURRENCY ?? "2");
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("WORKER_CONCURRENCY must be an integer from 1 to 16");
const port = Number(process.env.WORKER_NUDGE_PORT ?? "4711");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("WORKER_NUDGE_PORT must be a valid port");
const safetyMs = Number(process.env.WORKER_SAFETY_POLL_MS ?? "21600000");
if (!Number.isSafeInteger(safetyMs) || safetyMs < 21600000 || safetyMs > 2147483647) throw new Error("WORKER_SAFETY_POLL_MS must be at least six hours and timer-safe");
const { db, pool } = connectDb();
const storage = createStorage();
const queue = createQueue(db);

const runner = new DrainRunner(queue, concurrency, jobLeaseMs(), async (job, signal) => {
  if (job.kind !== "source.probe") throw new Error(`Unknown job kind: ${job.kind}`);
  const sourceId = (job.payload as SourceProbePayload).sourceId;
  if (typeof sourceId !== "string") throw new Error("Invalid source.probe payload");
  return ingest(db, storage, sourceId, signal);
});
const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/nudge") { res.writeHead(404).end(); return; }
  req.resume();
  runner.drain();
  res.writeHead(202).end();
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});
console.info(`Worker localhost nudge listener 127.0.0.1:${port}; concurrency ${concurrency}`);
console.info("Worker startup drain; inspecting existing claimed leases");
const claimed = await db.select({ id: jobs.id, claimedAt: jobs.claimedAt }).from(jobs)
  .where(and(eq(jobs.state, "claimed"), isNull(jobs.deletedAt)));
for (const row of claimed) if (row.claimedAt) runner.watchLease(row.id, row.claimedAt);
runner.drain();
const safety = setInterval(() => { console.info("Worker six-hour safety drain"); runner.drain(); }, safetyMs);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(safety);
  server.close();
  await runner.stop();
  await pool.end();
}
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });