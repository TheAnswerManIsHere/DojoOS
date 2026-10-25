// Step-0 journeys through the screens (architecture.md §9, step 0): a real browser walks the
// sign-in page, the library with the tester's feedback rail, and the operator's feedback page,
// against the same spawned server and migrated test database as step0.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { and, eq } from "drizzle-orm";
import { feedback, users } from "@workspace/shared";
import { operatorEmail, removeQuestion, requireTestDatabase, seedQuestion, startServer, testerEmail, type RunningServer } from "./harness";
import { openPage as openBrowserPage, signInFromPage as signIn } from "./browser";

const questionKey = "step0-browser";
const prompt = "Step-0 browser journey: does the library make sense?";
const { db, pool } = requireTestDatabase();
let server: RunningServer;
let browser: Browser;

before(async () => {
  await seedQuestion(db, questionKey, prompt);
  server = await startServer();
  browser = await chromium.launch();
});

after(async () => {
  try {
    await browser?.close();
    await server?.stop();
  } finally {
    await removeQuestion(db, questionKey);
    await pool.end();
  }
});

const openPage = () => openBrowserPage(browser);
const signInFromPage = (page: Awaited<ReturnType<typeof openPage>>, email: string) => signIn(page, server.origin, email);

test("the tester signs in from the page, answers the rendered rail, and the operator reads it on the feedback page", async () => {
  const tester = await openPage();
  await signInFromPage(tester, testerEmail);
  const rail = tester.getByRole("complementary", { name: "Tester questions" });
  const answer = `Browser answer ${Date.now()}`;
  await rail.getByLabel(prompt).fill(answer);
  await rail.getByRole("button", { name: "Submit answer" }).click();
  await rail.getByRole("status").filter({ hasText: "Answer submitted." }).waitFor();

  const [account] = await db.select().from(users).where(eq(users.email, testerEmail));
  const rows = await db.select().from(feedback).where(and(eq(feedback.questionKey, questionKey), eq(feedback.answer, answer)));
  assert.equal(rows.length, 1, "the rendered form stored exactly one answer");
  assert.equal(rows[0].userId, account.id);
  assert.equal(rows[0].page, "/library");

  await tester.getByTestId("button-sign-out").click();
  await tester.waitForURL(`${server.origin}/sign-in`);
  await tester.context().close();

  const operator = await openPage();
  await signInFromPage(operator, operatorEmail);
  assert.equal(await operator.getByRole("complementary", { name: "Tester questions" }).count(), 1, "in prototype phase the operator has the rail too (David, 2026-10-25)");
  await operator.goto(`${server.origin}/feedback`);
  await operator.getByTestId(`row-feedback-${rows[0].id}`).filter({ hasText: answer }).waitFor();
  await operator.context().close();
});
