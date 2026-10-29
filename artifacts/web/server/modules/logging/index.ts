// The logging viewer's routes (PLAN_LOGGING_VIEWER.md §3; architecture.md §5): one source's bricks, transcript and
// derived media; one command of the closed set at a time, applied by `applyCommand` and saved with its source-owned
// event in one transaction; and the peaks file, relayed because the bucket is private and serves no cross-origin read.
import { Router } from "express";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { applyCommand, bricks, CommandError, cutEvents, isCommand, newId, shoots, sources, spriteLayout, transcripts,
  type Action, type LogBrick } from "@workspace/shared";
import type { Context } from "../../context";

type BrickRow = typeof bricks.$inferSelect;

export function toLogBrick(row: BrickRow): LogBrick {
  const a = row.attributes ?? {};
  return { id: row.id, inMs: row.inMs, outMs: row.outMs, openSeq: typeof a.openSeq === "number" ? a.openSeq : null,
    action: a.action === "punch_in" ? "punch_in" : "keep", preset: typeof a.preset === "string" ? a.preset : null, tags: row.tags,
    note: typeof a.note === "string" ? a.note : null };
}

function rowValues(brick: LogBrick) {
  return { inMs: brick.inMs, outMs: brick.outMs, tags: brick.tags,
    attributes: { action: brick.action satisfies Action, preset: brick.preset, openSeq: brick.openSeq, note: brick.note ?? null } };
}

async function readySource(ctx: Context, id: string) {
  const [row] = await ctx.db.select({ source: sources, shootName: shoots.name }).from(sources).innerJoin(shoots, eq(sources.shootId, shoots.id))
    .where(and(eq(sources.id, id), isNull(sources.deletedAt), eq(sources.ingestState, "ready")));
  return row;
}

export function loggingRoutes(ctx: Context) {
  const router = Router();

  router.get("/sources/:id/log", async (req, res) => {
    const found = await readySource(ctx, req.params.id as string);
    if (!found?.source.proxyKey || !found.source.durationMs) return res.status(404).json({ error: "Source not ready to log" });
    const { source } = found;
    const durationMs = found.source.durationMs;
    const rows = await ctx.db.select().from(bricks).where(and(eq(bricks.sourceId, source.id), isNull(bricks.deletedAt))).orderBy(bricks.inMs);
    const [transcript] = await ctx.db.select({ words: transcripts.words }).from(transcripts)
      .where(and(eq(transcripts.sourceId, source.id), isNull(transcripts.deletedAt))).orderBy(desc(transcripts.createdAt)).limit(1);
    const layout = source.spriteKey && source.width && source.height ? spriteLayout(durationMs, source.width, source.height) : null;
    return res.json({
      sourceId: source.id, shootName: found.shootName, durationMs, fps: source.fps,
      bricks: rows.map(toLogBrick), words: transcript?.words?.length ? transcript.words : null,
      spriteUrl: layout ? await ctx.storage.playback(source.spriteKey!) : null, spriteLayout: layout, hasPeaks: !!source.peaksKey,
    });
  });

  router.get("/sources/:id/peaks", async (req, res) => {
    const found = await readySource(ctx, req.params.id as string);
    if (!found?.source.peaksKey) return res.status(404).json({ error: "No peaks for this source" });
    try {
      return res.type("application/json").send(await ctx.storage.readText(found.source.peaksKey));
    } catch (error) {
      console.error("Peaks read failed", found.source.id, error);
      return res.status(502).json({ error: "Could not read the peaks file" });
    }
  });

  router.post("/sources/:id/commands", async (req, res) => {
    const id = req.params.id as string;
    const raw = req.body?.command;
    // The client opens a brick without naming it; the server gives it its id.
    const command = raw?.type === "open" && raw.id === undefined ? { ...raw, id: newId() } : raw;
    if (!isCommand(command)) return res.status(400).json({ error: "Not a command of the set" });
    try {
      const result = await ctx.db.transaction(async (tx) => {
        // The source row is locked so two commands on one source apply one after the other, and their events keep order.
        const [source] = await tx.select().from(sources).where(and(eq(sources.id, id), isNull(sources.deletedAt), eq(sources.ingestState, "ready")))
          .for("update");
        if (!source?.durationMs) return null;
        const before = (await tx.select().from(bricks).where(and(eq(bricks.sourceId, id), isNull(bricks.deletedAt)))).map(toLogBrick);
        const { state, inverse } = applyCommand({ durationMs: source.durationMs, bricks: before }, command);
        const was = new Map(before.map((b) => [b.id, b]));
        const now = new Map(state.bricks.map((b) => [b.id, b]));
        for (const brick of state.bricks) {
          const old = was.get(brick.id);
          if (!old) {
            // A restored brick reuses its soft-deleted row; a new one is inserted.
            const restored = await tx.update(bricks).set({ ...rowValues(brick), deletedAt: null })
              .where(and(eq(bricks.id, brick.id), eq(bricks.sourceId, id))).returning({ id: bricks.id });
            if (!restored.length) await tx.insert(bricks).values({ id: brick.id, sourceId: id, ...rowValues(brick) });
          } else if (JSON.stringify(old) !== JSON.stringify(brick)) {
            await tx.update(bricks).set(rowValues(brick)).where(eq(bricks.id, brick.id));
          }
        }
        const removed = before.filter((b) => !now.has(b.id)).map((b) => b.id);
        if (removed.length) await tx.update(bricks).set({ deletedAt: new Date() }).where(inArray(bricks.id, removed));
        const [{ next }] = await tx.select({ next: sql<number>`coalesce(max(${cutEvents.sequence}), 0) + 1` }).from(cutEvents)
          .where(eq(cutEvents.sourceId, id));
        await tx.insert(cutEvents).values({ sourceId: id, sequence: Number(next), command, actor: req.account!.id });
        return { bricks: [...state.bricks].sort((a, b) => a.inMs - b.inMs), inverse };
      });
      if (!result) return res.status(404).json({ error: "Source not ready to log" });
      return res.json(result);
    } catch (error) {
      if (error instanceof CommandError) return res.status(409).json({ error: error.message });
      throw error;
    }
  });

  return router;
}
