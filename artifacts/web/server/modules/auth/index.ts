import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { users, sessions } from "@workspace/shared";
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
/** The two people and their accounts (David, 2026-10-25: "Simple user name and password please. KISS."). A username
 * names a person; the person's password is a secret set in Replit, never stored in the database or sent anywhere. Jared
 * is the operator account and David the tester account (David, 2026-10-25). */
export const people = { jared: { tier: "operator", secret: "JARED_PASSWORD" }, david: { tier: "tester", secret: "DAVID_PASSWORD" } } as const;
type Person = keyof typeof people;

/** Wrong passwords are throttled per username and per address: ten failures in fifteen minutes locks that one out for
 * the rest of the window. Held in memory, so a restart clears it. */
const windowMs = 15 * 60_000, maxFailures = 10;
const failures = new Map<string, number[]>();
const recent = (key: string) => (failures.get(key) ?? []).filter((at) => at > Date.now() - windowMs);
const throttled = (...keys: string[]) => keys.some((key) => recent(key).length >= maxFailures);
function fail(...keys: string[]) { for (const key of keys) failures.set(key, [...recent(key), Date.now()]); }
/** Equal-time comparison of two strings of any length: both are hashed first, so the lengths never differ. */
const same = (a: string, b: string) => timingSafeEqual(createHmac("sha256", "compare").update(a).digest(), createHmac("sha256", "compare").update(b).digest());

export function authRoutes(ctx: Context) {
  const router = Router();
  router.post("/login", async (req, res) => {
    const username = String(req.body?.username ?? "").trim().toLowerCase();
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const userKey = `user:${username}`, ipKey = `ip:${req.ip}`;
    if (throttled(userKey, ipKey)) return res.status(429).json({ error: "Too many wrong passwords. Wait 15 minutes and try again." });
    const person = Object.hasOwn(people, username) ? people[username as Person] : null;
    const expected = person ? process.env[person.secret] : undefined;
    if (person && !expected) return res.status(503).json({ error: `No password is set for ${username} yet (the ${person.secret} secret).` });
    // A wrong username and a wrong password get the same answer, after the same work.
    if (!same(password, expected ?? "\u0000no-account") || !person || !password) {
      fail(userKey, ipKey);
      return res.status(401).json({ error: "Wrong username or password." });
    }
    const [user] = await ctx.db.select().from(users).where(and(eq(users.tier, person.tier), isNull(users.deletedAt)));
    if (!user) return res.status(403).json({ error: "Account unavailable" });
    failures.delete(userKey);
    await startSession(ctx, res, user.id);
    return res.json({ id: user.id, email: user.email, tier: user.tier });
  });
  // Development only: no password, just who you are (David, 2026-10-24: "it's fine to ask which user I am, David or
  // Jared but no password"). A published (production) app signs in by username and password, so this route does not
  // exist there.
  router.post("/choose", async (req, res) => {
    if (process.env.NODE_ENV === "production") return res.status(404).json({ error: "Not found" });
    const who = String(req.body?.who);
    const person = Object.hasOwn(people, who) ? people[who as Person] : null;
    if (!person) return res.status(400).json({ error: "Say who you are: jared or david" });
    const [user] = await ctx.db.select().from(users).where(and(eq(users.tier, person.tier), isNull(users.deletedAt)));
    if (!user) return res.status(403).json({ error: "Account unavailable" });
    await startSession(ctx, res, user.id);
    return res.json({ id: user.id, email: user.email, tier: user.tier });
  });
  return router;
}
async function startSession(ctx: Context, res: Response, userId: string) {
  const session = token();
  await ctx.db.insert(sessions).values({ userId, tokenHash: hash(session), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000) });
  res.cookie(cookieName, session, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 7 * 24 * 60 * 60_000 });
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