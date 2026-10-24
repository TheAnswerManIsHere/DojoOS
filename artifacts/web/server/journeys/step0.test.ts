// Step-0 scripted journeys at the server boundary (architecture.md §9, step 0): the real
// server, spawned as it runs in development, driven over HTTP against a migrated database.
// What the screens do with these responses is step0-browser.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { feedback } from "@workspace/shared";
import { operatorEmail, removeQuestion, requireTestDatabase, seedQuestion, startServer, testerEmail, type RunningServer } from "./harness";

const questionKey = "step0-journey";
const { db, pool } = requireTestDatabase();
let server: RunningServer;
let origin: string;

type Session = { cookie: string; account: { id: string; email: string; tier: string } };

async function signIn(email: string): Promise<Session> {
  const requested = await fetch(`${origin}/app-api/auth/request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  assert.equal(requested.status, 200);
  const { magicLink } = (await requested.json()) as { ok: true; magicLink?: string };
  assert.ok(magicLink, "development sign-in returns the magic link in the response");
  const token = new URL(magicLink).searchParams.get("token");
  assert.ok(token, "the magic link carries a token");
  const verified = await fetch(`${origin}/app-api/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  assert.equal(verified.status, 200);
  const setCookie = verified.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^dojo_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookie = setCookie.split(";")[0];
  const account = (await verified.json()) as Session["account"];
  assert.equal(account.email, email);
  // The link is single-use: a second verification of the same token is refused.
  const replay = await fetch(`${origin}/app-api/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  assert.equal(replay.status, 400);
  return { cookie, account };
}

const get = (path: string, session?: Session) => fetch(`${origin}${path}`, { headers: session ? { cookie: session.cookie } : {}, redirect: "manual" });

before(async () => {
  await seedQuestion(db, questionKey, "Step-0 journey: does the library make sense?");
  server = await startServer();
  origin = server.origin;
});

after(async () => {
  try { await server?.stop(); } finally {
    await removeQuestion(db, questionKey);
    await pool.end();
  }
});

test("signed-out requests are refused: the gate holds before any page is served", async () => {
  assert.equal((await get("/library")).status, 401);
  assert.equal((await get("/feedback")).status, 401);
  assert.equal((await get("/app-api/session")).status, 401);
});

test("an address that is not configured gets { ok: true } and no link", async () => {
  // In development a configured address gets its link in the same response, by design, so this
  // is not a comparison of the two replies. In production both branches end at the one
  // `res.json({ ok: true })` in modules/auth (the request route's last line), which is where
  // the no-enumeration property lives; that path is not exercised here.
  const response = await fetch(`${origin}/app-api/auth/request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "nobody@example.test" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("the operator signs in by magic link and reaches the library and the feedback page", async () => {
  const operator = await signIn(operatorEmail);
  assert.equal(operator.account.tier, "operator");
  const session = await get("/app-api/session", operator);
  assert.equal(session.status, 200);
  assert.equal(((await session.json()) as { tier: string }).tier, "operator");
  const library = await get("/library", operator);
  assert.equal(library.status, 200);
  assert.match(library.headers.get("content-type") ?? "", /text\/html/);
  assert.equal((await get("/feedback", operator)).status, 200);
  const root = await get("/", operator);
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/library");
});

test("the tester answers the rail's question and the operator reads the answer back", async () => {
  const tester = await signIn(testerEmail);
  assert.equal(tester.account.tier, "tester");
  const listed = await get("/app-api/questions?feature=library", tester);
  assert.equal(listed.status, 200);
  const asked = (await listed.json()) as Array<{ key: string; prompt: string }>;
  assert.ok(asked.some((q) => q.key === questionKey), "the active question is offered on the library page");

  const answer = `Journey answer ${Date.now()}`;
  const posted = await fetch(`${origin}/app-api/feedback`, {
    method: "POST", headers: { "content-type": "application/json", cookie: tester.cookie },
    body: JSON.stringify({ questionKey, answer, page: "/library", state: { shoot: null } }),
  });
  assert.equal(posted.status, 201);
  const row = (await posted.json()) as { id: string; answer: string; userId: string; buildVersion: string };
  assert.equal(row.answer, answer);
  assert.equal(row.userId, tester.account.id);

  // The tester sees neither the operator's list nor the operator's page.
  assert.equal((await get("/app-api/feedback", tester)).status, 403);
  assert.equal((await get("/feedback", tester)).status, 403);

  const operator = await signIn(operatorEmail);
  const read = await get("/app-api/feedback", operator);
  assert.equal(read.status, 200);
  const rows = (await read.json()) as Array<{ id: string; answer: string; userId: string; questionKey: string }>;
  const found = rows.find((r) => r.id === row.id);
  assert.ok(found, "the operator's list carries the tester's answer");
  assert.equal(found.answer, answer);
  assert.equal(found.questionKey, questionKey);
  assert.equal(found.userId, tester.account.id);
  // And the operator cannot answer for the tester.
  const asOperator = await fetch(`${origin}/app-api/feedback`, {
    method: "POST", headers: { "content-type": "application/json", cookie: operator.cookie },
    body: JSON.stringify({ questionKey, answer, page: "/library", state: {} }),
  });
  assert.equal(asOperator.status, 403);
  const stored = await db.select().from(feedback).where(and(eq(feedback.questionKey, questionKey), eq(feedback.id, row.id)));
  assert.equal(stored.length, 1);
});

test("an answer for a question that is not active on that page is refused", async () => {
  const tester = await signIn(testerEmail);
  const wrongPage = await fetch(`${origin}/app-api/feedback`, {
    method: "POST", headers: { "content-type": "application/json", cookie: tester.cookie },
    body: JSON.stringify({ questionKey, answer: "misfiled", page: "/feedback", state: {} }),
  });
  assert.equal(wrongPage.status, 400);
});

test("a cross-origin mutation is refused even with a valid session", async () => {
  const tester = await signIn(testerEmail);
  const forged = await fetch(`${origin}/app-api/feedback`, {
    method: "POST", headers: { "content-type": "application/json", cookie: tester.cookie, origin: "https://elsewhere.example" },
    body: JSON.stringify({ questionKey, answer: "forged", page: "/library", state: {} }),
  });
  assert.equal(forged.status, 403);
  const sameOrigin = await fetch(`${origin}/app-api/feedback`, {
    method: "POST", headers: { "content-type": "application/json", cookie: tester.cookie, origin },
    body: JSON.stringify({ questionKey, answer: "same origin", page: "/library", state: {} }),
  });
  assert.equal(sameOrigin.status, 201);
});

test("prototype phase: in development you say who you are and are let in, with no link and no password", async () => {
  const choose = (who: string) => fetch(`${origin}/app-api/auth/choose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ who }) });
  const jared = await choose("jared");
  assert.equal(jared.status, 200);
  assert.deepEqual([((await jared.json()) as Session["account"]).email], [testerEmail], "Jared is the tester account, who answers the rail");
  const cookie = (jared.headers.get("set-cookie") ?? "").split(";")[0];
  assert.equal((await fetch(`${origin}/app-api/session`, { headers: { cookie } })).status, 200, "the session works like a signed-in one");
  const david = await choose("david");
  assert.equal(((await david.json()) as Session["account"]).email, operatorEmail, "David is the operator account, who reads the answers");
  assert.equal((await choose("someone")).status, 400, "only the two people the app knows");
});
