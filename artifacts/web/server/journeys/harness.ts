// Shared fixture for the step-0 journeys: the real web server, spawned as it runs in
// development, against a migrated test database the journeys may write to.
import { spawn } from "node:child_process";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { connectDb, feedback, questions } from "@workspace/shared";

export const operatorEmail = "operator.journey@example.test";
export const testerEmail = "tester.journey@example.test";
const webRoot = fileURLToPath(new URL("../../", import.meta.url));

export type Db = ReturnType<typeof connectDb>["db"];
export type RunningServer = { origin: string; log: () => string; stop: () => Promise<void> };

// Refuses to run without a database rather than passing on an empty evaluation, and refuses
// one whose name does not say it is for tests (`test`, or ending in `_test`): the server seeds
// its own operator and tester at boot and disables every other account.
export function requireTestDatabase() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required: the step-0 journeys run against a migrated database");
  const name = new URL(process.env.DATABASE_URL).pathname.slice(1);
  if (!/(^|_)test$/i.test(name)) throw new Error(`DATABASE_URL must name a test database ("test" or ending in "_test", not "${name}"): the journeys reseed accounts`);
  return connectDb();
}

export async function freePort() {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

export async function startServer(): Promise<RunningServer> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port), BASE_PATH: "/",
    OPERATOR_EMAIL: operatorEmail, TESTER_EMAIL: testerEmail, JARED_PASSWORD: passwords.jared, DAVID_PASSWORD: passwords.david,
    SESSION_SECRET: "step0-journey-session-secret-not-for-any-real-deployment",
    // createStorage() only constructs a client at boot; nothing in these journeys reaches the bucket.
    S3_ENDPOINT: "http://127.0.0.1:9", S3_REGION: "local", S3_BUCKET: "journey", S3_ACCESS_KEY_ID: "journey", S3_SECRET_ACCESS_KEY: "journey",
    WORKER_NUDGE_PORT: String(await freePort()),
  };
  delete env.NODE_ENV; // development: the page also offers the no-password picker
  delete env.REPL_ID;
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], { cwd: webRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  // The child is owned from the moment it is spawned: a startup failure, the 60 s timeout
  // included, stops it before the error is reported, so a failed check never leaves a live
  // process holding the test run open.
  const stop = () => new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not listen within 60s:\n${log}`)), 60_000);
      const onData = (chunk: Buffer) => {
        log += chunk.toString();
        if (log.includes(`DojoOS web listening on ${port}`)) { clearTimeout(timer); resolve(); }
      };
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code} before listening:\n${log}`)); });
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { origin: `http://127.0.0.1:${port}`, log: () => log, stop };
}

// The product seeds no questions (README): each journey owns one row under its own key.
export async function seedQuestion(db: Db, key: string, prompt: string) {
  await db.insert(questions).values({ feature: "library", key, prompt, position: 1, active: true })
    .onConflictDoUpdate({ target: questions.key, set: { active: true, deletedAt: null, feature: "library", prompt } });
}
export async function removeQuestion(db: Db, key: string) {
  await db.delete(feedback).where(eq(feedback.questionKey, key));
  await db.delete(questions).where(eq(questions.key, key));
}

/** The journeys' passwords: set on the spawned server, never a real one. */
export const passwords = { jared: "journey-password-jared-not-for-any-deployment", david: "journey-password-david-not-for-any-deployment" };
/** Signs in over HTTP with a username and password, as the published sign-in page does, and returns the session cookie. */
export async function signInOverHttp(origin: string, email: string): Promise<string> {
  const username = email === operatorEmail ? "jared" : email === testerEmail ? "david" : null;
  if (!username) throw new Error(`no person for ${email}`);
  const response = await fetch(`${origin}/app-api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: passwords[username] }) });
  if (response.status !== 200) throw new Error(`sign-in failed with ${response.status}`);
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}
