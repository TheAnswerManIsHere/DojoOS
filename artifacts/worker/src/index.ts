import { GetObjectCommand } from "@aws-sdk/client-s3";
import { eq, and, isNull, or } from "drizzle-orm";
import { connectDb, createQueue, createStorage, sources, jobs, jobLeaseMs } from "@workspace/shared";
import type { SourceProbePayload, SourceProbeResult } from "@workspace/shared";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { DrainRunner } from "./runner";

const concurrency = Number(process.env.WORKER_CONCURRENCY ?? "2");
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("WORKER_CONCURRENCY must be an integer from 1 to 16");
const port = Number(process.env.WORKER_NUDGE_PORT ?? "4711");
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("WORKER_NUDGE_PORT must be a valid port");
const safetyMs = Number(process.env.WORKER_SAFETY_POLL_MS ?? "21600000");
if (!Number.isSafeInteger(safetyMs) || safetyMs < 21600000 || safetyMs > 2147483647) throw new Error("WORKER_SAFETY_POLL_MS must be at least six hours and timer-safe");
const { db, pool } = connectDb();
const storage = createStorage();
const queue = createQueue(db);

async function probe(file: string, signal: AbortSignal): Promise<SourceProbeResult> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], { signal });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 4_000_000) child.kill(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`ffprobe exited ${code}: ${stderr.slice(0, 1000)}`)));
  });
  const data = JSON.parse(output) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string }> };
  const video = data.streams?.find((s) => s.codec_type === "video");
  const ratio = video?.avg_frame_rate?.split("/").map(Number);
  return {
    durationMs: Number.isFinite(Number(data.format?.duration ?? video?.duration)) ? Math.round(Number(data.format?.duration ?? video?.duration) * 1000) : null,
    width: video?.width ?? null, height: video?.height ?? null,
    fps: ratio?.length === 2 && ratio[1] ? ratio[0] / ratio[1] : null,
    probe: data,
  };
}
async function execute(sourceId: string, signal: AbortSignal) {
  const [source] = await db.select().from(sources).where(and(eq(sources.id, sourceId), or(eq(sources.ingestState, "uploaded"), eq(sources.ingestState, "probing"))));
  if (!source || source.deletedAt) throw new Error("Source is missing or not uploaded");
  await db.update(sources).set({ ingestState: "probing" }).where(eq(sources.id, sourceId));
  const dir = await mkdtemp(join(tmpdir(), "dojo-probe-"));
  try {
    const object = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: source.originalKey }), { abortSignal: signal });
    if (!object.Body) throw new Error("Stored source was empty");
    const file = join(dir, "source");
    await pipeline(Readable.fromWeb(object.Body.transformToWebStream() as import("node:stream/web").ReadableStream), createWriteStream(file), { signal });
    const result = await probe(file, signal);
    signal.throwIfAborted();
    await db.update(sources).set({ ...result, ingestState: "ready" }).where(eq(sources.id, sourceId));
    return result;
  } catch (error) {
    await db.update(sources).set({ ingestState: signal.aborted ? "uploaded" : "failed" }).where(eq(sources.id, sourceId));
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const runner = new DrainRunner(queue, concurrency, jobLeaseMs(), async (job, signal) => {
  if (job.kind !== "source.probe") throw new Error(`Unknown job kind: ${job.kind}`);
  const sourceId = (job.payload as SourceProbePayload).sourceId;
  if (typeof sourceId !== "string") throw new Error("Invalid source.probe payload");
  return execute(sourceId, signal);
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