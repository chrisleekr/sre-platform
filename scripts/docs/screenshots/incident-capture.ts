import type { BrowserContext, Page } from 'playwright';

/** Synthetic Slack credentials cannot resolve a real provider-owned permalink. */
export async function createPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.route('**/incidents/*/slack-permalink', (route) =>
    route.fulfill({ json: { permalink: null } }),
  );
  return page;
}

/** Wait for the seeded conversation and evidence, not only the HTTP page shell. */
export async function prepareIncidentCapture(page: Page): Promise<void> {
  await page.getByText('Live updates: open', { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'All evidence · 6 loaded', exact: true }).waitFor();
  await page.getByLabel('Loading Slack link…').waitFor({ state: 'hidden' });
  await page
    .getByText('Did the config repo raise the pool ceiling as well?', { exact: false })
    .waitFor();
  const supporting = page.getByRole('complementary', { name: 'Supporting evidence' });
  await supporting
    .getByText('Loading recorded preview…', { exact: true })
    .first()
    .waitFor({ state: 'hidden' });
  await supporting.locator('svg').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
}

export async function captureIncidentInspector(page: Page, path: string): Promise<void> {
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('button', { name: /checkout_request_duration_seconds/ })
    .first()
    .click();
  await dialog.getByRole('img', { name: /prometheus metric evidence/ }).waitFor();
  await page.screenshot({ path });
}
