// Imports footage that already sits somewhere shareable — a Google Drive link, or any direct URL — into the library,
// run by hand in the Repl, where the bucket's credentials are:
//   pnpm --filter @workspace/worker exec tsx src/import.ts <url> [<url> ...]
// Each file becomes its own shoot, named after the file (one lesson a file, as Jared's Drive folders are), with one
// camera_a source whose original goes to the private bucket under originals/<source id>, exactly where a browser
// upload puts it. Then source.probe is queued and the worker nudged, so ingest, the proxy and transcription follow as
// they do for an upload. A file whose shoot already exists with a live source is skipped, so a rerun imports only
// what is missing.
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, eq, isNull } from "drizzle-orm";
import { connectDb, createQueue, createStorage, shoots, sources } from "@workspace/shared";

/** A Drive file's sharing link becomes its direct download, past the large-file warning page; anything else is fetched as given. */
export function downloadUrl(url: string): string {
  const drive = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:.*&)?id=)([\w-]+)/.exec(url);
  return drive ? `https://drive.usercontent.google.com/download?id=${drive[1]}&export=download&confirm=t` : url;
}

/** The file's own name from Content-Disposition, extension dropped, else the URL's last segment. */
export function nameFrom(disposition: string | null, url: string): string {
  const star = disposition && /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plain = disposition && /filename="?([^";]+)"?/i.exec(disposition);
  const file = star ? decodeURIComponent(star[1]) : plain ? plain[1] : decodeURIComponent(new URL(url).pathname.split("/").pop() || "import");
  return file.replace(/\.[^.]+$/, "").trim() || "import";
}

const urls = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (!urls.length) throw new Error("Give one or more URLs to import");
  const { db, pool } = connectDb();
  const storage = createStorage();
  const queue = createQueue(db);
  for (const url of urls) {
    const response = await fetch(downloadUrl(url));
    if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.startsWith("text/html")) throw new Error(`${url} returned a web page, not a file: is it shared as "anyone with the link"?`);
    const name = nameFrom(response.headers.get("content-disposition"), url);
    const [existing] = await db.select({ id: sources.id }).from(sources).innerJoin(shoots, eq(sources.shootId, shoots.id))
      .where(and(eq(shoots.name, name), isNull(shoots.deletedAt), isNull(sources.deletedAt)));
    if (existing) { await response.body.cancel(); console.info(`Skipped ${name}: already imported as source ${existing.id}`); continue; }
    const dir = await mkdtemp(join(tmpdir(), "dojo-import-"));
    try {
      const file = join(dir, "original");
      const started = performance.now();
      await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(file));
      const [shoot] = await db.insert(shoots).values({ name, notes: `Imported from ${url}` }).returning();
      const [source] = await db.insert(sources).values({ shootId: shoot.id, role: "camera_a", originalKey: "pending" }).returning();
      const key = `originals/${source.id}`;
      try {
        await storage.put(key, file, contentType.startsWith("video/") || contentType.startsWith("audio/") ? contentType : "application/octet-stream");
      } catch (error) {
        // Withdrawn rather than left uploading, so a rerun imports the file again instead of skipping it.
        await db.update(sources).set({ deletedAt: new Date() }).where(eq(sources.id, source.id));
        await db.update(shoots).set({ deletedAt: new Date() }).where(eq(shoots.id, shoot.id));
        throw error;
      }
      await db.update(sources).set({ originalKey: key, ingestState: "uploaded" }).where(eq(sources.id, source.id));
      await queue.enqueue("source.probe", { sourceId: source.id });
      console.info(`Imported ${name} as source ${source.id} in ${Math.round((performance.now() - started) / 1000)} s`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  await pool.end();
  const port = Number(process.env.WORKER_NUDGE_PORT ?? "4711");
  await fetch(`http://127.0.0.1:${port}/nudge`, { method: "POST", signal: AbortSignal.timeout(1500) })
    .then(() => console.info("Worker nudged"), () => console.info("Worker not reachable; it picks the jobs up at its next poll or restart"));
}
