// The lesson's routes (PLAN_LESSON_TIMELINE.md §3; architecture.md §5–§6): a shoot's one lesson cut, created on first
// open with every closed brick of the shoot; one command of the lesson's closed set at a time, applied by
// `applyLessonCommand` and saved with its cut-owned event in one transaction; and Render, which freezes the resolved
// lesson as a revision and queues the job that renders that revision — never the live cut.
import { createHash } from "node:crypto";
import { Router } from "express";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { applyLessonCommand, bricks, CommandError, cutBricks, cutEvents, cuts, initialOrder, isLessonCommand, jobs, newId,
  resolveCut, revisions, shoots, sources, spriteLayout, edlLengthMs, transcripts, type LessonBrick, type LessonEntry, type LessonState,
  type Transition } from "@workspace/shared";
import type { Context } from "../../context";
import { numberBricks } from "../logging";

type Tx = Parameters<Parameters<Context["db"]["transaction"]>[0]>[0];
type Db = Context["db"] | Tx;
/** The render's fixed defaults in this version (no templates yet, step 5). */
export const renderDefaults = { width: 1920, height: 1080, fps: 30, videoCodec: "h264", audioCodec: "aac" };

/** The shoot's closed, live bricks on its live sources, and the order its files were added. */
async function shootBricks(db: Db, shootId: string) {
  const files = await db.select({ id: sources.id }).from(sources).where(and(eq(sources.shootId, shootId), isNull(sources.deletedAt)))
    .orderBy(asc(sources.createdAt), asc(sources.id));
  const ids = files.map((f) => f.id);
  const rows = ids.length ? await db.select().from(bricks).where(and(inArray(bricks.sourceId, ids), isNull(bricks.deletedAt), isNotNull(bricks.outMs))) : [];
  const all: LessonBrick[] = rows.map((b) => {
    const a = b.attributes ?? {};
    return { id: b.id, sourceId: b.sourceId, inMs: b.inMs, outMs: b.outMs!, tags: b.tags, number: b.number ?? null,
      action: a.action === "punch_in" ? "punch_in" : "keep", preset: typeof a.preset === "string" ? a.preset : null };
  });
  return { bricks: initialOrder(all, ids), sourceOrder: ids };
}

function toEntry(row: typeof cutBricks.$inferSelect): LessonEntry {
  const o = row.overrides ?? {};
  return { id: row.id, brickId: row.brickId, trimInMs: o.trimDeltas?.inMs ?? 0, trimOutMs: o.trimDeltas?.outMs ?? 0,
    transition: o.transition === "dissolve" ? "dissolve" : "cut" };
}
const overridesOf = (e: LessonEntry) => ({ trimDeltas: { inMs: e.trimInMs, outMs: e.trimOutMs }, transition: e.transition as Transition });

/** The cut's state: its live entries in position order, skipping any whose brick has since been deleted or reopened. */
async function lessonState(db: Db, cut: typeof cuts.$inferSelect): Promise<LessonState> {
  const { bricks: all } = await shootBricks(db, cut.shootId);
  const known = new Set(all.map((b) => b.id));
  const rows = await db.select().from(cutBricks).where(and(eq(cutBricks.cutId, cut.id), isNull(cutBricks.deletedAt)))
    .orderBy(asc(cutBricks.position), asc(cutBricks.id));
  return { entries: rows.filter((r) => known.has(r.brickId)).map(toEntry), bricks: all };
}

export function resolveLesson(state: LessonState) {
  const brickOf = new Map(state.bricks.map((b) => [b.id, b]));
  return resolveCut({ orientation: "16:9" }, state.entries.map((entry) => ({ entry, brick: brickOf.get(entry.brickId)! })), renderDefaults);
}

/** The shoot's lesson cut, created — with every closed brick, in D1's order — when it does not exist yet. */
async function lessonCut(ctx: Context, shootId: string) {
  return ctx.db.transaction(async (tx) => {
    // The shoot row is locked so two first opens create one lesson.
    const [shoot] = await tx.select().from(shoots).where(and(eq(shoots.id, shootId), isNull(shoots.deletedAt))).for("update");
    if (!shoot) return null;
    const [found] = await tx.select().from(cuts).where(and(eq(cuts.shootId, shootId), eq(cuts.kind, "lesson"), isNull(cuts.deletedAt)))
      .orderBy(asc(cuts.createdAt)).limit(1);
    if (found) return { cut: found, shoot };
    const [cut] = await tx.insert(cuts).values({ shootId, kind: "lesson", mode: "camera", name: `${shoot.name} — lesson` }).returning();
    const { bricks: all } = await shootBricks(tx, shootId);
    if (all.length) await tx.insert(cutBricks).values(all.map((b, position) => ({ cutId: cut.id, brickId: b.id, position,
      overrides: { trimDeltas: { inMs: 0, outMs: 0 }, transition: "cut" } })));
    return { cut, shoot };
  });
}

/** Everything the lesson page shows. */
async function lessonView(ctx: Context, cut: typeof cuts.$inferSelect, shootName: string) {
  const state = await lessonState(ctx.db, cut);
  const resolved = resolveLesson(state);
  const included = new Set(state.entries.map((e) => e.brickId));
  const files = await ctx.db.select().from(sources).where(and(eq(sources.shootId, cut.shootId), isNull(sources.deletedAt)))
    .orderBy(asc(sources.createdAt), asc(sources.id));
  const media = await Promise.all(files.map(async (s) => {
    const layout = s.spriteKey && s.width && s.height && s.durationMs ? spriteLayout(s.durationMs, s.width, s.height) : null;
    const [transcript] = await ctx.db.select({ words: transcripts.words }).from(transcripts)
      .where(and(eq(transcripts.sourceId, s.id), isNull(transcripts.deletedAt))).orderBy(desc(transcripts.createdAt)).limit(1);
    return { id: s.id, role: s.role, fps: s.fps, hasProxy: !!s.proxyKey, hasPeaks: !!s.peaksKey, durationMs: s.durationMs,
      spriteUrl: layout ? await ctx.storage.playback(s.spriteKey!) : null, spriteLayout: layout,
      words: transcript?.words?.length ? transcript.words : null };
  }));
  const revs = await ctx.db.select().from(revisions).where(and(eq(revisions.cutId, cut.id), isNull(revisions.deletedAt))).orderBy(desc(revisions.number));
  const renderJobs = revs.length ? await ctx.db.select({ state: jobs.state, error: jobs.error, payload: jobs.payload, result: jobs.result }).from(jobs)
    .where(and(eq(jobs.kind, "cut.render"), isNull(jobs.deletedAt), inArray(sql`${jobs.payload}->>'revisionId'`, revs.map((r) => r.id))))
    .orderBy(desc(jobs.createdAt)) : [];
  const jobOf = new Map<string, (typeof renderJobs)[number]>();
  for (const j of renderJobs) { const id = String(j.payload.revisionId); if (!jobOf.has(id)) jobOf.set(id, j); }
  const brickOf = new Map(state.bricks.map((b) => [b.id, b]));
  return {
    cutId: cut.id, shootId: cut.shootId, shootName,
    entries: state.entries.map((e) => ({ ...e, sourceId: brickOf.get(e.brickId)!.sourceId, brickInMs: brickOf.get(e.brickId)!.inMs,
      brickOutMs: brickOf.get(e.brickId)!.outMs, tags: brickOf.get(e.brickId)!.tags, brickNumber: brickOf.get(e.brickId)!.number ?? null,
      action: brickOf.get(e.brickId)!.action ?? "keep", preset: brickOf.get(e.brickId)!.preset ?? null })),
    available: state.bricks.filter((b) => !included.has(b.id)),
    resolved, lengthMs: edlLengthMs(resolved), sources: media,
    renders: revs.map((r) => {
      const job = jobOf.get(r.id);
      return { id: r.id, number: r.number, createdAt: r.createdAt.toISOString(), lengthMs: edlLengthMs(r.resolvedEdl as ReturnType<typeof resolveCut>),
        state: r.renderKey ? "ready" : job?.state ?? "not queued", error: job?.state === "failed" ? job.error ?? null : null,
        bytes: typeof (r.metadata as Record<string, unknown>).bytes === "number" ? (r.metadata as { bytes: number }).bytes : null };
    }),
  };
}

export function cutRoutes(ctx: Context) {
  const router = Router();

  router.get("/shoots/:id/lesson", async (req, res) => {
    await numberBricks(ctx.db, req.params.id as string);
    const found = await lessonCut(ctx, req.params.id as string);
    if (!found) return res.status(404).json({ error: "No such shoot" });
    return res.json(await lessonView(ctx, found.cut, found.shoot.name));
  });

  router.post("/cuts/:id/commands", async (req, res) => {
    const id = req.params.id as string;
    const raw = req.body?.command;
    // The client adds a brick without naming the entry; the server gives it its id and an untrimmed cut after it.
    const command = raw?.type === "add" && raw.entry && raw.entry.id === undefined
      ? { ...raw, entry: { trimInMs: 0, trimOutMs: 0, transition: "cut", ...raw.entry, id: newId() } } : raw;
    if (!isLessonCommand(command)) return res.status(400).json({ error: "Not a command of the set" });
    try {
      const result = await ctx.db.transaction(async (tx) => {
        // The cut row is locked so two commands on one lesson apply one after the other, and their events keep order.
        const [cut] = await tx.select().from(cuts).where(and(eq(cuts.id, id), isNull(cuts.deletedAt))).for("update");
        if (!cut) return null;
        const before = await lessonState(tx, cut);
        const { state, inverse } = applyLessonCommand(before, command);
        const was = new Map(before.entries.map((e) => [e.id, e]));
        for (const [position, entry] of state.entries.entries()) {
          const values = { position, overrides: overridesOf(entry) };
          if (!was.has(entry.id)) {
            // A removed entry that comes back reuses its row; a new one is inserted.
            const restored = await tx.update(cutBricks).set({ ...values, deletedAt: null })
              .where(and(eq(cutBricks.id, entry.id), eq(cutBricks.cutId, id), eq(cutBricks.brickId, entry.brickId))).returning({ id: cutBricks.id });
            if (!restored.length) await tx.insert(cutBricks).values({ id: entry.id, cutId: id, brickId: entry.brickId, ...values });
          } else await tx.update(cutBricks).set(values).where(eq(cutBricks.id, entry.id));
        }
        const now = new Set(state.entries.map((e) => e.id));
        const removed = before.entries.filter((e) => !now.has(e.id)).map((e) => e.id);
        if (removed.length) await tx.update(cutBricks).set({ deletedAt: new Date() }).where(inArray(cutBricks.id, removed));
        const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${cutEvents.sequence}), 0) + 1` }).from(cutEvents)
          .where(eq(cutEvents.cutId, id));
        await tx.insert(cutEvents).values({ cutId: id, sequence: Number(next), command, actor: req.account!.id });
        return { cut, inverse };
      });
      if (!result) return res.status(404).json({ error: "No such lesson" });
      const [shoot] = await ctx.db.select({ name: shoots.name }).from(shoots).where(eq(shoots.id, result.cut.shootId));
      return res.json({ lesson: await lessonView(ctx, result.cut, shoot.name), inverse: result.inverse });
    } catch (error) {
      if (error instanceof CommandError) return res.status(409).json({ error: error.message });
      throw error;
    }
  });

  // Render: the lesson as it stands now is resolved and frozen into a numbered revision, and the job renders that.
  router.post("/cuts/:id/render", async (req, res) => {
    const id = req.params.id as string;
    const revision = await ctx.db.transaction(async (tx) => {
      const [cut] = await tx.select().from(cuts).where(and(eq(cuts.id, id), isNull(cuts.deletedAt))).for("update");
      if (!cut) return null;
      const resolved = resolveLesson(await lessonState(tx, cut));
      if (!resolved.picture.length) return "empty" as const;
      const [{ number }] = await tx.select({ number: sql<number>`coalesce(max(${revisions.number}), 0) + 1` }).from(revisions).where(eq(revisions.cutId, id));
      const digest = createHash("sha256").update(JSON.stringify(resolved)).digest("hex");
      const [row] = await tx.insert(revisions).values({ cutId: id, number: Number(number), resolvedEdl: resolved, templateSnapshot: renderDefaults,
        digest, metadata: { requestedBy: req.account!.id } }).returning();
      return { row, shootId: cut.shootId };
    });
    if (!revision) return res.status(404).json({ error: "No such lesson" });
    if (revision === "empty") return res.status(409).json({ error: "The lesson has no bricks to render" });
    await ctx.queue.enqueue("cut.render", { revisionId: revision.row.id, shootId: revision.shootId });
    return res.status(202).json({ id: revision.row.id, number: revision.row.number });
  });

  // The rendered file, by a short-lived signed link: to play in the page, or to download.
  router.get(["/revisions/:id/file", "/revisions/:id/download"], async (req, res) => {
    const [row] = await ctx.db.select({ renderKey: revisions.renderKey, number: revisions.number, cutName: cuts.name }).from(revisions)
      .innerJoin(cuts, eq(revisions.cutId, cuts.id)).where(and(eq(revisions.id, req.params.id as string), isNull(revisions.deletedAt)));
    if (!row?.renderKey) return res.status(404).json({ error: "Not rendered yet" });
    const download = req.path.endsWith("/download") ? `${row.cutName} r${row.number}.mp4`.replace(/[^\w .—-]+/g, "") : undefined;
    return res.json({ url: await ctx.storage.playback(row.renderKey, download) });
  });

  return router;
}
