// Shared browser steps for the journeys: a fresh page per account, and sign-in the way an emailed link is
// followed — the sign-in page requests it, the page renders it in development, the browser follows it, and the
// page verifies the token and lands on the library.
import type { Browser, Page } from "playwright";

export async function openPage(browser: Browser) {
  const page = await (await browser.newContext()).newPage();
  page.setDefaultTimeout(60_000); // the first load of a page compiles it through Vite
  return page;
}

export async function signInFromPage(page: Page, origin: string, email: string) {
  await page.goto(`${origin}/sign-in`);
  await page.getByTestId("input-email").fill(email);
  await page.getByTestId("button-request-link").click();
  await page.getByTestId("status-check-inbox").getByRole("link", { name: "Sign in to DojoOS" }).click();
  await page.waitForURL(`${origin}/library`);
  await page.getByTestId("text-account-email").filter({ hasText: email }).waitFor();
}
