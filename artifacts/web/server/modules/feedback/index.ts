import { Router } from "express";
import { and, eq, isNull, asc, desc } from "drizzle-orm";
import { feedback, questions } from "@workspace/shared";
import type { Context } from "../../context";
import loggingViewerQuestions from "../../../src/prototypes/logging-viewer/questions.json" with { type: "json" };

/** The feature a page belongs to, for the rail: a prototype's page answers that prototype's questions. */
export function featureOfPage(page: string): string | null {
  if (page === "/library") return "library";
  if (page === "/feedback") return "feedback";
  if (/^\/sources\/[A-Za-z0-9]{1,64}\/log$/.test(page)) return "logging-viewer";
  return null;
}
const features = ["library", "feedback", "logging-viewer"];

/** A prototype's questions file is the source of its questions (the prototype skill): synced into the table at boot,
 * so the rail serves exactly what the file says, and a question taken out of the file is retired, not deleted. */
export async function syncPrototypeQuestions(ctx: Context) {
  const file = loggingViewerQuestions;
  for (const [position, q] of file.questions.entries()) {
    await ctx.db.insert(questions).values({ feature: file.feature, key: q.key, prompt: q.prompt, position: position + 1, active: true })
      .onConflictDoUpdate({ target: questions.key, set: { feature: file.feature, prompt: q.prompt, position: position + 1, active: true, deletedAt: null } });
  }
  const keys = file.questions.map((q) => q.key);
  const stale = await ctx.db.select({ key: questions.key }).from(questions).where(and(eq(questions.feature, file.feature), eq(questions.active, true)));
  for (const { key } of stale) if (!keys.includes(key)) await ctx.db.update(questions).set({ active: false }).where(eq(questions.key, key));
}

export function feedbackRoutes(ctx: Context) {
  const router = Router();
  router.get("/questions", async (req, res) => {
    if (req.account?.tier !== "tester") return res.status(403).json({ error: "Tester only" });
    const feature = req.query.feature;
    if (typeof feature !== "string" || !features.includes(feature)) return res.status(400).json({ error: "Invalid feature" });
    const rows = await ctx.db.select().from(questions)
      .where(and(eq(questions.feature, feature), eq(questions.active, true), isNull(questions.deletedAt)))
      .orderBy(asc(questions.position));
    return res.json(rows.map(({ id, feature, key, prompt, position }) => ({ id, feature, key, prompt, position })));
  });
  router.post("/feedback", async (req, res) => {
    if (req.account?.tier !== "tester") return res.status(403).json({ error: "Tester only" });
    const { questionKey, answer, page, state } = req.body ?? {};
    if (typeof questionKey !== "string" || typeof answer !== "string" || !answer.trim() || answer.length > 10000 ||
      typeof page !== "string" || !featureOfPage(page) || !state || typeof state !== "object" || Array.isArray(state))
      return res.status(400).json({ error: "Invalid answer" });
    const [question] = await ctx.db.select().from(questions).where(and(eq(questions.key, questionKey), eq(questions.active, true), isNull(questions.deletedAt)));
    if (!question || question.feature !== featureOfPage(page)) return res.status(400).json({ error: "Question is not active for this page" });
    const [row] = await ctx.db.insert(feedback).values({
      userId: req.account.id, questionKey, answer: answer.trim(), page, state, buildVersion: process.env.BUILD_VERSION ?? "development",
    }).returning();
    return res.status(201).json(row);
  });
  router.get("/feedback", async (req, res) => {
    if (req.account?.tier !== "operator") return res.status(403).json({ error: "Operator only" });
    const rows = await ctx.db.select().from(feedback).where(isNull(feedback.deletedAt)).orderBy(desc(feedback.createdAt));
    return res.json(rows);
  });
  return router;
}