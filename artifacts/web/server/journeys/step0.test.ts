// Step-0 scripted journeys (architecture.md §9, step 0): the real server, spawned as
// it runs in development, driven over HTTP against a migrated database.
//
// Needs DATABASE_URL pointing at a migrated database the test may write to. It refuses
// to run without one rather than passing on an empty evaluation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { connectDb, feedback, questions } from "@workspace/shared";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required: the step-0 journeys run against a migrated database");
// The server seeds its own operator and tester at boot and disables every other account, so
// these journeys never run against a database whose name does not say it is for tests.
if (!/test/i.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error("DATABASE_URL must name a test database (its name contains \"test\"): the journeys reseed accounts");

const operatorEmail = "operator.journey@example.test";
const testerEmail = "tester.journey@example.test";
const questionKey = "step0-journey";
const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const { db, pool } = connectDb();

let server: ChildProcess;
let origin: string;
let serverLog = "";

async function freePort() {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startServer(port: number) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port), BASE_PATH: "/",
    OPERATOR_EMAIL: operatorEmail, TESTER_EMAIL: testerEmail,
    SESSION_SECRET: "step0-journey-session-secret-not-for-any-real-deployment",
    // createStorage() only constructs a client at boot; nothing in these journeys reaches the bucket.
    S3_ENDPOINT: "http://127.0.0.1:9", S3_REGION: "local", S3_BUCKET: "journey", S3_ACCESS_KEY_ID: "journey", S3_SECRET_ACCESS_KEY: "journey",
    WORKER_NUDGE_PORT: String(await freePort()),
  };
  delete env.NODE_ENV; // development: the magic link comes back in the response instead of going out by mail
  delete env.SMTP_URL;
  delete env.REPL_ID;
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { cwd: webRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  const listening = new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      serverLog += chunk.toString();
      if (serverLog.includes(`DojoOS web listening on ${port}`)) resolve();
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("exit", (code) => reject(new Error(`server exited with ${code} before listening:\n${serverLog}`)));
    setTimeout(() => reject(new Error(`server did not listen within 60s:\n${serverLog}`)), 60_000).unref();
  });
  await listening;
  return child;
}

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
  await db.insert(questions).values({ feature: "library", key: questionKey, prompt: "Step-0 journey: does the library make sense?", position: 1, active: true })
    .onConflictDoUpdate({ target: questions.key, set: { active: true, deletedAt: null, feature: "library" } });
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  server = await startServer(port);
});

after(async () => {
  server?.kill("SIGTERM");
  await new Promise((resolve) => server?.once("exit", resolve));
  await db.delete(feedback).where(eq(feedback.questionKey, questionKey));
  await db.delete(questions).where(eq(questions.key, questionKey));
  await pool.end();
});

test("signed-out requests are refused: the gate holds before any page is served", async () => {
  assert.equal((await get("/library")).status, 401);
  assert.equal((await get("/feedback")).status, 401);
  assert.equal((await get("/app-api/session")).status, 401);
});

test("an address that is not configured gets the same reply as one that is, and no link", async () => {
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
