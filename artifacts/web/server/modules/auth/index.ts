import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { users, magicTokens, sessions } from "@workspace/shared";
import nodemailer from "nodemailer";
import type { Context } from "../../context";

const cookieName = "dojo_session";
function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return value;
}
const hash = (value: string) => createHmac("sha256", secret()).update(value).digest("hex");
function token() {
  const nonce = randomBytes(32).toString("base64url");
  return `${nonce}.${hash(nonce)}`;
}
function validToken(raw: string) {
  const [nonce, signature] = raw.split(".");
  if (!nonce || !signature || !/^[\da-f]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(hash(nonce)));
}
function cookies(req: Request) {
  return Object.fromEntries((req.headers.cookie ?? "").split(";").map((s) => s.trim().split("=")).filter((v) => v.length === 2));
}
export type Account = { id: string; email: string; tier: "operator" | "tester" };
declare global {
  namespace Express { interface Request { account?: Account } }
}
export async function seedAccounts(ctx: Context) {
  const operator = process.env.OPERATOR_EMAIL?.trim().toLowerCase();
  const tester = process.env.TESTER_EMAIL?.trim().toLowerCase();
  if (!operator || !tester || operator === tester) throw new Error("Distinct OPERATOR_EMAIL and TESTER_EMAIL are required");
  for (const [email, tier] of [[operator, "operator"], [tester, "tester"]] as const) {
    await ctx.db.insert(users).values({ email, tier }).onConflictDoUpdate({ target: users.email, set: { tier, deletedAt: null } });
  }
  // Only configured accounts can sign in. Existing records are retained for audit, but disabled.
  await ctx.db.update(users).set({ deletedAt: new Date() }).where(sql`${users.email} not in (${operator}, ${tester}) and ${users.deletedAt} is null`);
}
export function authRoutes(ctx: Context) {
  const router = Router();
  router.post("/request", async (req, res) => {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Valid email required" });
    const [user] = await ctx.db.select().from(users).where(and(eq(users.email, email), isNull(users.deletedAt)));
    if (user) {
      const value = token();
      await ctx.db.insert(magicTokens).values({ userId: user.id, tokenHash: hash(value), expiresAt: new Date(Date.now() + 15 * 60_000) });
      if (process.env.NODE_ENV !== "production" && !process.env.SMTP_URL) {
        const origin = process.env.APP_ORIGIN ?? `${req.protocol}://${req.get("host")}`;
        return res.json({ ok: true, magicLink: new URL(`/sign-in?token=${encodeURIComponent(value)}`, origin).toString() });
      }
      if (!process.env.SMTP_URL || !process.env.MAIL_FROM || !process.env.APP_ORIGIN) throw new Error("SMTP_URL, MAIL_FROM and APP_ORIGIN are required to send sign-in links");
      const transport = nodemailer.createTransport(process.env.SMTP_URL);
      await transport.sendMail({
        from: process.env.MAIL_FROM, to: user.email, subject: "Sign in to DojoOS",
        text: `Use this single-use link within 15 minutes:\n${new URL(`/sign-in?token=${encodeURIComponent(value)}`, process.env.APP_ORIGIN).toString()}\n`,
      });
    }
    return res.json({ ok: true });
  });
  router.post("/verify", async (req, res) => {
    const raw = req.body?.token;
    if (typeof raw !== "string" || !validToken(raw)) return res.status(400).json({ error: "Invalid or expired link" });
    const [record] = await ctx.db.update(magicTokens).set({ usedAt: new Date() })
      .where(and(eq(magicTokens.tokenHash, hash(raw)), isNull(magicTokens.usedAt), isNull(magicTokens.deletedAt), gt(magicTokens.expiresAt, new Date())))
      .returning();
    if (!record) return res.status(400).json({ error: "Invalid or expired link" });
    const [user] = await ctx.db.select().from(users).where(and(eq(users.id, record.userId), isNull(users.deletedAt)));
    if (!user) return res.status(403).json({ error: "Account unavailable" });
    const session = token();
    await ctx.db.insert(sessions).values({ userId: user.id, tokenHash: hash(session), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000) });
    res.cookie(cookieName, session, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 7 * 24 * 60 * 60_000 });
    return res.json({ id: user.id, email: user.email, tier: user.tier });
  });
  return router;
}
export function requireSession(ctx: Context) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const raw = cookies(req)[cookieName];
    if (!raw || !validToken(raw)) return res.status(401).json({ error: "Sign in required" });
    const [record] = await ctx.db.select({ id: users.id, email: users.email, tier: users.tier })
      .from(sessions).innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.tokenHash, hash(raw)), gt(sessions.expiresAt, new Date()), isNull(sessions.deletedAt), isNull(users.deletedAt)));
    if (!record) return res.status(401).json({ error: "Sign in required" });
    req.account = record;
    return next();
  };
}
export function sessionRoutes(ctx: Context) {
  const router = Router();
  router.get("/session", (req, res) => res.json(req.account));
  router.post("/auth/logout", async (req, res) => {
    const raw = cookies(req)[cookieName];
    if (raw) await ctx.db.update(sessions).set({ deletedAt: new Date() }).where(eq(sessions.tokenHash, hash(raw)));
    res.clearCookie(cookieName, { path: "/" });
    res.json({ ok: true });
  });
  return router;
}