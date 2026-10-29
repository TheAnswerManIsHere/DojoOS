// Ingest (architecture.md §4): stage the original once, probe it, make the proxy, delete the local original, then make
// the sprite and peaks while the proxy uploads, and mark the source ready. The disk peak is one original plus its
// derivatives. The returned measurements are the job's result: step 0's file size, bitrate and probe time, and step
// 1's proxy wall time and peak memory.
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { derivedKeys, sources, type connectDb, type createStorage, type SourceIngestResult } from "@workspace/shared";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { makePeaks, makeProxy, makeSprite, probe } from "./media";
import { scratchDir } from "./scratch";

type Db = ReturnType<typeof connectDb>["db"];
type Storage = ReturnType<typeof createStorage>;
const since = (started: number) => Math.round(performance.now() - started);

/** Ingest runs for any source whose original is complete and which does not yet have its proxy: a fresh upload, a
 * retry after a failure, an interrupted run, and a source marked ready before ingest made derivatives (step 0). */
export function ingestable(source: Pick<typeof sources.$inferSelect, "deletedAt" | "ingestState" | "proxyKey">) {
  if (source.deletedAt || source.ingestState === "uploading") return false;
  return !(source.ingestState === "ready" && source.proxyKey);
}

/** Where an ingest stands, for the library's step tracker: the stage under way and how far through it. */
export type IngestProgress = { stage: "download" | "proxy" | "derivatives"; fraction: number | null };

export async function ingest(db: Db, storage: Storage, sourceId: string, signal: AbortSignal,
  report: (progress: IngestProgress) => void = () => {}): Promise<SourceIngestResult> {
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
  if (!source || !ingestable(source)) throw new Error("Source is missing, still uploading, or already has its proxy");
  await db.update(sources).set({ ingestState: "probing" }).where(eq(sources.id, sourceId));
  const dir = await mkdtemp(join(scratchDir(), "dojo-ingest-"));
  try {
    const file = join(dir, "source");
    const downloadStarted = performance.now();
    const object = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: source.originalKey }), { abortSignal: signal });
    if (!object.Body) throw new Error("Stored source was empty");
    const size = object.ContentLength ?? 0;
    let received = 0;
    report({ stage: "download", fraction: size ? 0 : null });
    const counted = Readable.fromWeb(object.Body.transformToWebStream() as ReadableStream);
    counted.on("data", (chunk: Buffer) => { received += chunk.length; if (size) report({ stage: "download", fraction: received / size }); });
    await pipeline(counted, createWriteStream(file), { signal });
    const downloadMs = since(downloadStarted);
    const originalBytes = (await stat(file)).size;
    const probeStarted = performance.now();
    const original = await probe(file, signal);
    const probeMs = since(probeStarted);
    const { hasVideo, hasAudio } = original;
    if (!hasVideo && !hasAudio) throw new Error("The file has neither a video nor an audio stream");
    signal.throwIfAborted();
    const { durationMs, width, height, fps } = original;
    await db.update(sources).set({ durationMs, width, height, fps, probe: original.probe, ingestState: "proxying" }).where(eq(sources.id, sourceId));

    const keys = derivedKeys(sourceId);
    const proxyFile = join(dir, "proxy.mp4"), spriteFile = join(dir, "sprite.jpg"), peaksFile = join(dir, "peaks.json");
    report({ stage: "proxy", fraction: 0 });
    const proxy = await makeProxy(file, proxyFile, signal, { hasVideo, hasAudio },
      { durationMs, report: (fraction) => report({ stage: "proxy", fraction }) });
    report({ stage: "derivatives", fraction: null });
    await rm(file, { force: true });
    const proxied = await probe(proxyFile, signal);
    const spriteable = hasVideo && proxied.durationMs && proxied.width && proxied.height;
    // The proxy upload is the long tail; the sprite and peaks are made, and uploaded, alongside it.
    const uploadStarted = performance.now();
    const [, sprite, peaks] = await Promise.all([
      storage.put(keys.proxy, proxyFile, hasVideo ? "video/mp4" : "audio/mp4", signal),
      spriteable ? makeSprite(proxyFile, spriteFile, proxied.durationMs!, proxied.width!, proxied.height!, signal)
        .then(async (spent) => { await storage.put(keys.sprite, spriteFile, "image/jpeg", signal); return spent; }) : null,
      makePeaks(proxyFile, peaksFile, hasAudio, signal)
        .then(async (spent) => { await storage.put(keys.peaks, peaksFile, "application/json", signal); return spent; }),
    ]);
    const uploadMs = since(uploadStarted);
    signal.throwIfAborted();
    await db.update(sources).set({ proxyKey: keys.proxy, spriteKey: sprite ? keys.sprite : null, peaksKey: keys.peaks, ingestState: "ready" })
      .where(eq(sources.id, sourceId));
    const result: SourceIngestResult = { durationMs, width, height, fps, originalBytes, originalBitRate: original.bitRate,
      downloadMs, probeMs, proxy, sprite, peaks, uploadMs };
    console.info("Ingest complete", sourceId, JSON.stringify(result));
    return result;
  } catch (error) {
    await db.update(sources).set({ ingestState: signal.aborted ? "uploaded" : "failed" }).where(eq(sources.id, sourceId));
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
