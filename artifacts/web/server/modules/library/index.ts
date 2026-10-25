import { Router } from "express";
import { and, eq, isNull, isNotNull, desc, inArray, sql } from "drizzle-orm";
import { jobs, revisions, shoots, sources, transcripts } from "@workspace/shared";
import type { Context } from "../../context";

type IngestJob = Pick<typeof jobs.$inferSelect, "state" | "error">;
/** A source can be processed again when ingest failed, or when it was marked ready before ingest made a proxy (step 0),
 * and no ingest job for it is queued or running (architecture.md §2: "the operator retries from the page"). */
function publicSource(row: typeof sources.$inferSelect, latestJob?: IngestJob, transcriptWords: number | null = null, transcribeJob?: IngestJob) {
  const busy = latestJob?.state === "queued" || latestJob?.state === "claimed";
  const unfinished = row.ingestState === "failed" || (row.ingestState === "ready" && !row.proxyKey);
  return {
    id: row.id, role: row.role, ingestState: row.ingestState, durationMs: row.durationMs, width: row.width, height: row.height, fps: row.fps,
    hasProxy: !!row.proxyKey,
    lastError: row.ingestState === "failed" ? latestJob?.error ?? null : null,
    retryable: unfinished && !busy,
    transcriptWords,
    transcriptionState: transcribeJob?.state ?? null,
    transcriptionError: transcribeJob?.state === "failed" ? transcribeJob.error ?? null : null,
  };
}
export function libraryRoutes(ctx: Context) {
  const router = Router();
  router.get("/shoots", async (_req, res) => {
    const rows = await ctx.db.select().from(shoots).where(isNull(shoots.deletedAt)).orderBy(desc(shoots.createdAt));
    const media = await ctx.db.select().from(sources).where(isNull(sources.deletedAt));
    const allJobs = await ctx.db.select({ kind: jobs.kind, state: jobs.state, error: jobs.error, payload: jobs.payload }).from(jobs)
      .where(and(inArray(jobs.kind, ["source.probe", "source.transcribe"]), isNull(jobs.deletedAt))).orderBy(desc(jobs.createdAt));
    const latest = new Map<string, IngestJob>();
    const latestTranscribe = new Map<string, IngestJob>();
    for (const job of allJobs) {
      const sourceId = job.payload?.sourceId;
      const map = job.kind === "source.transcribe" ? latestTranscribe : latest;
      if (typeof sourceId === "string" && !map.has(sourceId)) map.set(sourceId, job);
    }
    // The newest transcript's word count per source, read without loading the words themselves.
    const counts = await ctx.db.selectDistinctOn([transcripts.sourceId], { sourceId: transcripts.sourceId,
      words: sql<number>`jsonb_array_length(${transcripts.words})` }).from(transcripts).where(isNull(transcripts.deletedAt))
      .orderBy(transcripts.sourceId, desc(transcripts.createdAt));
    const wordCounts = new Map(counts.map((c) => [c.sourceId, Number(c.words)]));
    // A lesson render queued or running, per shoot, so the library shows it while it runs (async-ui-status.md).
    const rendering = await ctx.db.select({ shootId: sql<string>`${jobs.payload}->>'shootId'`, state: jobs.state, number: revisions.number })
      .from(jobs).innerJoin(revisions, sql`${revisions.id} = ${jobs.payload}->>'revisionId'`)
      .where(and(eq(jobs.kind, "cut.render"), inArray(jobs.state, ["queued", "claimed"]), isNull(jobs.deletedAt))).orderBy(desc(jobs.createdAt));
    const renderOf = new Map<string, { number: number; state: string }>();
    for (const r of rendering) if (!renderOf.has(r.shootId)) renderOf.set(r.shootId, { number: r.number, state: r.state });
    res.json(rows.map((row) => ({ id: row.id, name: row.name, shotOn: row.shotOn, notes: row.notes, lessonRender: renderOf.get(row.id) ?? null,
      sources: media.filter((s) => s.shootId === row.id).map((s) => publicSource(s, latest.get(s.id), wordCounts.get(s.id) ?? null, latestTranscribe.get(s.id))) })));
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
  // Transcribe (again): a source with a proxy and no transcription queued or running gets one, so a changed vocabulary
  // list or a failed run can be redone from the library. The queue's enqueue wakes the worker.
  router.post("/sources/:id/transcribe", async (req, res) => {
    const id = req.params.id as string;
    const [source] = await ctx.db.select().from(sources).where(and(eq(sources.id, id), isNull(sources.deletedAt), isNotNull(sources.proxyKey),
      sql`not exists (select 1 from ${jobs} where ${jobs.kind} = 'source.transcribe' and ${jobs.payload}->>'sourceId' = ${sources.id}
        and ${jobs.state} in ('queued', 'claimed') and ${jobs.deletedAt} is null)`));
    if (!source) return res.status(409).json({ error: "Nothing to transcribe: the source has no proxy, a transcription is already queued or running, or it does not exist" });
    await ctx.queue.enqueue("source.transcribe", { sourceId: id });
    return res.status(202).json(publicSource(source, undefined, null, { state: "queued", error: null }));
  });
  router.get("/sources/:id/transcript", async (req, res) => {
    const [row] = await ctx.db.select().from(transcripts).innerJoin(sources, eq(transcripts.sourceId, sources.id))
      .where(and(eq(transcripts.sourceId, req.params.id as string), isNull(transcripts.deletedAt), isNull(sources.deletedAt)))
      .orderBy(desc(transcripts.createdAt)).limit(1);
    if (!row) return res.status(404).json({ error: "No transcript for this source yet" });
    const t = row.transcripts;
    return res.json({ provider: t.provider, version: t.version, createdAt: t.createdAt.toISOString(), words: t.words });
  });
  return router;
}
export { publicSource };