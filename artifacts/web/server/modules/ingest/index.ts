import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { shoots, sources, uploads } from "@workspace/shared";
import type { Context } from "../../context";
import { publicSource } from "../library";

export function ingestRoutes(ctx: Context) {
  const router = Router();
  router.post("/uploads", async (req, res) => {
    const { shootId, role, fileName, contentType } = req.body ?? {};
    if (typeof shootId !== "string" || !["camera_a", "camera_b", "audio"].includes(role) ||
      typeof fileName !== "string" || !fileName.trim() || typeof contentType !== "string" || !(/^(video|audio)\//.test(contentType) || contentType === "application/octet-stream"))
      return res.status(400).json({ error: "Valid shoot, role, media filename and content type required" });
    const [shoot] = await ctx.db.select({ id: shoots.id }).from(shoots).where(and(eq(shoots.id, shootId), isNull(shoots.deletedAt)));
    if (!shoot) return res.status(404).json({ error: "Shoot not found" });
    // The opaque source ULID, rather than the untrusted filename, determines the object key.
    const [source] = await ctx.db.insert(sources).values({ shootId, role, originalKey: "pending" }).returning();
    const key = `originals/${source.id}`;
    try {
      const uploadId = await ctx.storage.start(key, contentType);
      await ctx.db.update(sources).set({ originalKey: key }).where(eq(sources.id, source.id));
      await ctx.db.insert(uploads).values({ sourceId: source.id, uploadId });
      return res.status(201).json({ id: source.id, uploadId });
    } catch (error) {
      await ctx.db.update(sources).set({ ingestState: "failed" }).where(eq(sources.id, source.id));
      throw error;
    }
  });
  router.post("/uploads/:id/parts", async (req, res) => {
    const { uploadId, partNumber } = req.body ?? {};
    if (typeof uploadId !== "string" || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000)
      return res.status(400).json({ error: "Invalid part" });
    const [row] = await ctx.db.select({ source: sources, upload: uploads }).from(uploads).innerJoin(sources, eq(uploads.sourceId, sources.id))
      .where(and(eq(uploads.sourceId, req.params.id as string), eq(uploads.uploadId, uploadId), isNull(uploads.completedAt), isNull(uploads.deletedAt), isNull(sources.deletedAt)));
    if (!row) return res.status(404).json({ error: "Upload not found" });
    return res.json({ url: await ctx.storage.part(row.source.originalKey, uploadId, partNumber) });
  });
  router.post("/uploads/:id/complete", async (req, res) => {
    const { uploadId, parts } = req.body ?? {};
    if (typeof uploadId !== "string" || !Array.isArray(parts) || !parts.length || parts.length > 10000 ||
      parts.some((p) => !Number.isInteger(p.partNumber) || p.partNumber < 1 || typeof p.etag !== "string" || !p.etag) ||
      parts.some((p, i) => i > 0 && p.partNumber <= parts[i - 1].partNumber))
      return res.status(400).json({ error: "Parts must be sorted, unique and contain ETags" });
    const [row] = await ctx.db.select({ source: sources, upload: uploads }).from(uploads).innerJoin(sources, eq(uploads.sourceId, sources.id))
      .where(and(eq(uploads.sourceId, req.params.id as string), eq(uploads.uploadId, uploadId), isNull(uploads.deletedAt), isNull(sources.deletedAt)));
    if (!row) return res.status(404).json({ error: "Upload not found" });
    if (row.upload.completedAt) return res.json(publicSource(row.source));
    await ctx.storage.complete(row.source.originalKey, uploadId, parts);
    const [source] = await ctx.db.update(sources).set({ ingestState: "uploaded" }).where(eq(sources.id, row.source.id)).returning();
    await ctx.db.update(uploads).set({ completedAt: new Date() }).where(eq(uploads.id, row.upload.id));
    await ctx.queue.enqueue("source.probe", { sourceId: source.id });
    return res.json(publicSource(source));
  });
  router.get("/sources/:id/playback", async (req, res) => {
    const [source] = await ctx.db.select().from(sources).where(and(eq(sources.id, req.params.id as string), isNull(sources.deletedAt)));
    if (!source || source.ingestState === "uploading") return res.status(404).json({ error: "Source not available" });
    return res.json({ url: await ctx.storage.playback(source.proxyKey ?? source.originalKey) });
  });
  return router;
}