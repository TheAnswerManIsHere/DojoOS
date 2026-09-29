import { GetObjectCommand } from "@aws-sdk/client-s3";
import { eq, and } from "drizzle-orm";
import { connectDb, createQueue, createStorage, sources } from "@workspace/shared";
import type { SourceProbePayload, SourceProbeResult } from "@workspace/shared";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const concurrency = Number(process.env.WORKER_CONCURRENCY ?? "2");
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("WORKER_CONCURRENCY must be an integer from 1 to 16");
const { db, pool } = connectDb();
const storage = createStorage();
const queue = createQueue(db);
const workerId = randomUUID();
let running = true;
process.on("SIGTERM", () => { running = false; });
process.on("SIGINT", () => { running = false; });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(file: string): Promise<SourceProbeResult> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]);
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
async function execute(sourceId: string) {
  const [source] = await db.select().from(sources).where(and(eq(sources.id, sourceId), eq(sources.ingestState, "uploaded")));
  if (!source || source.deletedAt) throw new Error("Source is missing or not uploaded");
  await db.update(sources).set({ ingestState: "probing" }).where(eq(sources.id, sourceId));
  const dir = await mkdtemp(join(tmpdir(), "dojo-probe-"));
  try {
    const object = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: source.originalKey }));
    if (!object.Body) throw new Error("Stored source was empty");
    const file = join(dir, "source");
    await pipeline(Readable.fromWeb(object.Body.transformToWebStream() as import("node:stream/web").ReadableStream), createWriteStream(file));
    const result = await probe(file);
    await db.update(sources).set({ ...result, ingestState: "ready" }).where(eq(sources.id, sourceId));
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function loop() {
  while (running) {
    try {
      const job = await queue.claim(workerId);
      if (!job) { await sleep(2000); continue; }
      try {
        if (job.kind !== "source.probe") throw new Error(`Unknown job kind: ${job.kind}`);
        const sourceId = (job.payload as SourceProbePayload).sourceId;
        if (typeof sourceId !== "string") throw new Error("Invalid source.probe payload");
        const result = await execute(sourceId);
        if (!await queue.complete(job.id, workerId, result)) throw new Error("Lost job claim");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Job failed", job.id, message);
        if (job.kind === "source.probe" && typeof job.payload.sourceId === "string") {
          await db.update(sources).set({ ingestState: "failed" }).where(eq(sources.id, job.payload.sourceId));
        }
        await queue.fail(job.id, workerId, message);
      }
    } catch (error) {
      console.error("Worker poll failed", error);
      await sleep(5000);
    }
  }
}
console.info(`Worker ${workerId} started with concurrency ${concurrency}`);
await Promise.all(Array.from({ length: concurrency }, loop));
await pool.end();