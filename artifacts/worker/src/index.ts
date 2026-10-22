import { eq, and, isNull, isNotNull, sql } from "drizzle-orm";
import { connectDb, createQueue, createStorage, createTranscriber, jobs, jobLeaseMs, sources, transcripts } from "@workspace/shared";
import type { SourceProbePayload } from "@workspace/shared";
import { createServer } from "node:http";
import { DrainRunner } from "./runner";
import { ingest } from "./ingest";
import { transcribe } from "./transcribe";

const concurrency = Number(process.env.WORKER_CONCURRENCY ?? "2");
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("WORKER_CONCURRENCY must be an integer from 1 to 16");
const port = Number(process.env.WORKER_NUDGE_PORT ?? "4711");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("WORKER_NUDGE_PORT must be a valid port");
const safetyMs = Number(process.env.WORKER_SAFETY_POLL_MS ?? "21600000");
if (!Number.isSafeInteger(safetyMs) || safetyMs < 21600000 || safetyMs > 2147483647) throw new Error("WORKER_SAFETY_POLL_MS must be at least six hours and timer-safe");
const { db, pool } = connectDb();
const storage = createStorage();
const queue = createQueue(db);
const transcriber = createTranscriber();
console.info(transcriber ? `Transcription by ${transcriber.provider}` : "Transcription off: ASSEMBLYAI_API_KEY is not set");

const runner = new DrainRunner(queue, concurrency, jobLeaseMs(), async (job, signal) => {
  const sourceId = (job.payload as SourceProbePayload).sourceId;
  if (typeof sourceId !== "string") throw new Error(`Invalid ${job.kind} payload`);
  if (job.kind === "source.transcribe") {
    if (!transcriber) throw new Error("Transcription is off: ASSEMBLYAI_API_KEY is not set");
    return transcribe(db, storage, transcriber, sourceId, signal);
  }
  if (job.kind !== "source.probe") throw new Error(`Unknown job kind: ${job.kind}`);
  const result = await ingest(db, storage, sourceId, signal);
  // Transcription follows ingest as its own job, so its failure never repeats the original's download.
  if (transcriber) await queue.enqueue("source.transcribe", { sourceId });
  return result;
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
// The backfill: once a key is set, every playable source with no transcript and no transcription queued or running gets
// one, which covers sources ingested before transcription existed and any whose transcription failed.
if (transcriber) {
  const untranscribed = await db.select({ id: sources.id }).from(sources).where(and(
    isNull(sources.deletedAt), eq(sources.ingestState, "ready"), isNotNull(sources.proxyKey),
    sql`not exists (select 1 from ${transcripts} where ${transcripts.sourceId} = ${sources.id} and ${transcripts.deletedAt} is null)`,
    sql`not exists (select 1 from ${jobs} where ${jobs.kind} = 'source.transcribe' and ${jobs.payload}->>'sourceId' = ${sources.id}
      and ${jobs.state} in ('queued', 'claimed') and ${jobs.deletedAt} is null)`));
  for (const { id } of untranscribed) await queue.enqueue("source.transcribe", { sourceId: id });
  if (untranscribed.length) console.info(`Transcription backfill queued ${untranscribed.length} source(s)`);
}
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