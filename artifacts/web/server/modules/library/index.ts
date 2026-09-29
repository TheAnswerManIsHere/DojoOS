import { Router } from "express";
import { and, eq, isNull, desc } from "drizzle-orm";
import { shoots, sources } from "@workspace/shared";
import type { Context } from "../../context";

function publicSource(row: typeof sources.$inferSelect) {
  return { id: row.id, role: row.role, ingestState: row.ingestState, durationMs: row.durationMs, width: row.width, height: row.height, fps: row.fps };
}
export function libraryRoutes(ctx: Context) {
  const router = Router();
  router.get("/shoots", async (_req, res) => {
    const rows = await ctx.db.select().from(shoots).where(isNull(shoots.deletedAt)).orderBy(desc(shoots.createdAt));
    const media = await ctx.db.select().from(sources).where(isNull(sources.deletedAt));
    res.json(rows.map((row) => ({ id: row.id, name: row.name, shotOn: row.shotOn, notes: row.notes, sources: media.filter((s) => s.shootId === row.id).map(publicSource) })));
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