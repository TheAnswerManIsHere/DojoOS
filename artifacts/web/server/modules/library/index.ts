import { Router } from "express";
import { and, eq, isNull, desc } from "drizzle-orm";
import { jobs, shoots, sources } from "@workspace/shared";
import type { Context } from "../../context";

type IngestJob = Pick<typeof jobs.$inferSelect, "state" | "error">;
/** A source can be processed again when ingest failed, or when it was marked ready before ingest made a proxy (step 0),
 * and no ingest job for it is queued or running (architecture.md §2: "the operator retries from the page"). */
function publicSource(row: typeof sources.$inferSelect, latestJob?: IngestJob) {
  const busy = latestJob?.state === "queued" || latestJob?.state === "claimed";
  const unfinished = row.ingestState === "failed" || (row.ingestState === "ready" && !row.proxyKey);
  return {
    id: row.id, role: row.role, ingestState: row.ingestState, durationMs: row.durationMs, width: row.width, height: row.height, fps: row.fps,
    hasProxy: !!row.proxyKey,
    lastError: row.ingestState === "failed" ? latestJob?.error ?? null : null,
    retryable: unfinished && !busy,
  };
}
export function libraryRoutes(ctx: Context) {
  const router = Router();
  router.get("/shoots", async (_req, res) => {
    const rows = await ctx.db.select().from(shoots).where(isNull(shoots.deletedAt)).orderBy(desc(shoots.createdAt));
    const media = await ctx.db.select().from(sources).where(isNull(sources.deletedAt));
    const ingestJobs = await ctx.db.select({ state: jobs.state, error: jobs.error, payload: jobs.payload }).from(jobs)
      .where(and(eq(jobs.kind, "source.probe"), isNull(jobs.deletedAt))).orderBy(desc(jobs.createdAt));
    const latest = new Map<string, IngestJob>();
    for (const job of ingestJobs) {
      const sourceId = job.payload?.sourceId;
      if (typeof sourceId === "string" && !latest.has(sourceId)) latest.set(sourceId, job);
    }
    res.json(rows.map((row) => ({ id: row.id, name: row.name, shotOn: row.shotOn, notes: row.notes,
      sources: media.filter((s) => s.shootId === row.id).map((s) => publicSource(s, latest.get(s.id))) })));
  });
  router.post("/shoots", async (req, res) => {
    const name = req.body?.name;
    const shotOn = req.body?.shotOn;
    const notes = req.body?.notes;
    if (typeof name !== "string" || !name.trim() || name.length > 255) return res.status(400).json({ error: "Name required (max 255 characters)" });
    if (shotOn != null && (typeof shotOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(shotOn))) return res.status(400).json({ error: "Invalid date" });
    if (notes != null && (typeof notes !== "string" || notes.length > 10000)) return res.status(400).json({ error: "Invalid notes" });
    const [row] = await ctx.db.insert(shoots).values({ name: name.trim(), shotOn: shotOn || null, notes: notes || null }).returning();
    return res.status(201).json({ id: row.id, name: row.name, shotOn: row.shotOn, notes: row.notes, sources: [] });
  });
  return router;
}
export { publicSource };