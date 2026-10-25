// Step-0 journeys through the screens (architecture.md §9, step 0): a real browser walks the
// sign-in page, the library with the tester's feedback rail, and the operator's feedback page,
// against the same spawned server and migrated test database as step0.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright";
import { and, eq } from "drizzle-orm";
import { feedback, questions, users } from "@workspace/shared";
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

// The rail takes more than one answer in a sitting, and a failed send says so beside its own question and keeps the text
// (David, 2026-10-25: the second answer would not go, and the reason was out of sight at the bottom of the panel).
test("two answers in one sitting; a send that fails says so beside its question, keeps the text, and goes when pressed again", async () => {
  const secondKey = `${questionKey}-second`;
  await seedQuestion(db, secondKey, "Step-0 browser journey: a second question?");
  await db.update(questions).set({ position: 2 }).where(eq(questions.key, secondKey));
  try {
    const page = await openPage();
    await signInFromPage(page, testerEmail);
    const rows = async (key: string) => db.select().from(feedback).where(eq(feedback.questionKey, key));
    const boxes = page.locator("aside textarea");
    await boxes.first().waitFor();
    const ids = await page.locator("aside textarea").evaluateAll((els) => els.map((e) => e.id.replace("answer-", "")));
    const ofKey = async (key: string) => (await db.select().from(questions).where(eq(questions.key, key)))[0].id;
    const [firstId, secondId] = [await ofKey(questionKey), await ofKey(secondKey)];
    assert.ok(ids.includes(firstId) && ids.includes(secondId));

    const before = (await rows(questionKey)).length;
    await page.getByTestId(`input-answer-${firstId}`).fill("first answer");
    await page.getByTestId(`button-submit-answer-${firstId}`).click();
    await page.getByTestId(`status-answer-${firstId}`).waitFor();

    // The host answers with its "this app is not running" page for the second send.
    let down = true;
    await page.route("**/app-api/feedback", (route) => down && route.request().method() === "POST"
      ? route.fulfill({ status: 404, contentType: "text/html", body: "<!DOCTYPE html><html><head><title>Run this app to see the results here.</title></head></html>" })
      : route.continue());
    await page.getByTestId(`input-answer-${secondId}`).fill("second answer");
    await page.getByTestId(`button-submit-answer-${secondId}`).click();
    const error = page.getByTestId(`error-answer-${secondId}`);
    await error.waitFor();
    assert.match((await error.textContent()) ?? "", /Not sent: .*asleep or restarting.*press Submit again/);
    assert.ok(!(await error.textContent())!.includes("<!DOCTYPE"), "no raw page in the message");
    assert.equal(await page.getByTestId(`input-answer-${secondId}`).inputValue(), "second answer", "the typed answer stays");
    assert.equal((await rows(secondKey)).length, 0);

    down = false;
    await page.getByTestId(`button-submit-answer-${secondId}`).click();
    await page.getByTestId(`status-answer-${secondId}`).waitFor();
    assert.equal(await page.getByTestId(`error-answer-${secondId}`).count(), 0, "the error clears once it goes");
    assert.deepEqual([(await rows(questionKey)).length - before, (await rows(secondKey)).length], [1, 1], "each answer stored once");
    await page.context().close();
  } finally {
    await removeQuestion(db, secondKey);
  }
});
