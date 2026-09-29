import { Router } from "express";
import { and, eq, isNull, asc, desc } from "drizzle-orm";
import { feedback, questions } from "@workspace/shared";
import type { Context } from "../../context";

export function feedbackRoutes(ctx: Context) {
  const router = Router();
  router.get("/questions", async (req, res) => {
    if (req.account?.tier !== "tester") return res.status(403).json({ error: "Tester only" });
    const feature = req.query.feature;
    if (typeof feature !== "string" || !["library", "feedback"].includes(feature)) return res.status(400).json({ error: "Invalid feature" });
    const rows = await ctx.db.select().from(questions)
      .where(and(eq(questions.feature, feature), eq(questions.active, true), isNull(questions.deletedAt)))
      .orderBy(asc(questions.position));
    return res.json(rows.map(({ id, feature, key, prompt, position }) => ({ id, feature, key, prompt, position })));
  });
  router.post("/feedback", async (req, res) => {
    if (req.account?.tier !== "tester") return res.status(403).json({ error: "Tester only" });
    const { questionKey, answer, page, state } = req.body ?? {};
    if (typeof questionKey !== "string" || typeof answer !== "string" || !answer.trim() || answer.length > 10000 ||
      typeof page !== "string" || !["/library", "/feedback"].includes(page) || !state || typeof state !== "object" || Array.isArray(state))
      return res.status(400).json({ error: "Invalid answer" });
    const [question] = await ctx.db.select().from(questions).where(and(eq(questions.key, questionKey), eq(questions.active, true), isNull(questions.deletedAt)));
    if (!question || question.feature !== page.slice(1)) return res.status(400).json({ error: "Question is not active for this page" });
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