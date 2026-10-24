// Shared browser steps for the journeys: a fresh page per account, and getting in the way the development app lets
// you in during prototype phase — the page asks who you are, David or Jared, with no link and no password (David,
// 2026-10-24). Jared is the tester account (he answers the rail); David is the operator account (he reads it).
import type { Browser, Page } from "playwright";
import { operatorEmail, testerEmail } from "./harness";

export async function openPage(browser: Browser) {
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(60_000); // the first load of a page compiles it through Vite
  return page;
}

export async function signInFromPage(page: Page, origin: string, email: string) {
  const who = email === testerEmail ? "jared" : email === operatorEmail ? "david" : null;
  if (!who) throw new Error(`no person for ${email}`);
  await page.goto(`${origin}/sign-in`);
  await page.getByTestId(`button-i-am-${who}`).click();
  await page.waitForURL(`${origin}/library`);
  await page.getByTestId("text-account-email").filter({ hasText: email }).waitFor();
}
