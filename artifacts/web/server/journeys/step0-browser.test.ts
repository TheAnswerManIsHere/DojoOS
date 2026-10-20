// Step-0 journeys through the screens (architecture.md §9, step 0): a real browser walks the
// sign-in page, the library with the tester's feedback rail, and the operator's feedback page,
// against the same spawned server and migrated test database as step0.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { and, eq } from "drizzle-orm";
import { feedback, users } from "@workspace/shared";
import { operatorEmail, removeQuestion, requireTestDatabase, seedQuestion, startServer, testerEmail, type RunningServer } from "./harness";

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

async function openPage() {
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(60_000); // the first load of a page compiles it through Vite
  return page;
}

// The path an emailed link takes: the sign-in page requests the link, the browser follows it,
// the page verifies the token, seeds the session and lands on the library. In development the
// link is rendered on the page itself instead of being mailed.
async function signInFromPage(page: Page, email: string) {
  await page.goto(`${server.origin}/sign-in`);
  await page.getByTestId("input-email").fill(email);
  await page.getByTestId("button-request-link").click();
  await page.getByTestId("status-check-inbox").getByRole("link", { name: "Sign in to DojoOS" }).click();
  await page.waitForURL(`${server.origin}/library`);
  await page.getByTestId("text-account-email").filter({ hasText: email }).waitFor();
}

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
  assert.equal(await operator.getByRole("complementary", { name: "Tester questions" }).count(), 0, "the operator has no rail");
  await operator.goto(`${server.origin}/feedback`);
  await operator.getByTestId(`row-feedback-${rows[0].id}`).filter({ hasText: answer }).waitFor();
  await operator.context().close();
});
