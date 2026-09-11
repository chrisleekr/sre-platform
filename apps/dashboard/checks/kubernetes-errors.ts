import type { Page } from 'playwright';
import { resolve } from 'node:path';

/**
 * Exercise the real wizard and HTTP client against controlled API rejections.
 * @param page - Isolated browser page.
 * @param baseUrl - Local fixture server.
 * @param artifacts - Ignored screenshot directory.
 */
export async function verifyKubernetesErrors(page: Page, baseUrl: string, artifacts: string) {
  for (const width of [360, 1440]) {
    for (const theme of ['light', 'dark']) {
      let saves = 0;
      let tests = 0;
      await page.route('**/connectors/kubernetes**', async (route) => {
        if (route.request().url().endsWith('/test')) {
          tests += 1;
          await route.fulfill({
            json: {
              status: 'healthy',
              reachable: true,
              authorized: true,
              checks: { canListPods: true, secretsDenied: true },
              warnings: [],
              enabled: true,
            },
          });
          return;
        }
        saves += 1;
        const body = route.request().postDataJSON();
        if (saves === 1) {
          await route.fulfill({
            status: 409,
            json: { error: 'a data source with this name already exists' },
          });
          return;
        }
        if (body.name !== 'Second cluster' || body.credential !== 'test-only-token')
          throw new Error('Correction lost the name or token');
        await route.fulfill({ json: { connectorId: 'saved' } });
      });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${baseUrl}/__modal-layout?scenario=kubernetes-errors`);
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.getByLabel('API server URL').fill('https://cluster.example.test');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByLabel(/Service account token/).fill('test-only-token');
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await page.getByRole('button', { name: 'Save and verify', exact: true }).click();
      await page
        .getByRole('alert')
        .filter({ hasText: 'A data source with this name already exists' })
        .waitFor();
      if (tests !== 0) throw new Error('Verification ran before saving');
      const action = page.getByRole('button', { name: 'Edit data source name' });
      const bounds = await action.boundingBox();
      if (
        !bounds ||
        bounds.x < 0 ||
        bounds.x + bounds.width > width ||
        bounds.y + bounds.height > 900
      )
        throw new Error('Recovery action is outside the viewport');
      await page.screenshot({ path: resolve(artifacts, `kubernetes-error-${width}-${theme}.png`) });
      await action.click();
      await page.getByLabel(/Data source name/).fill('Second cluster');
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await page.getByRole('button', { name: 'Save and verify', exact: true }).click();
      await page.getByRole('button', { name: 'Finish', exact: true }).waitFor();
      if (saves !== 2 || Number(tests) !== 1)
        throw new Error('Unexpected save or verification count');
      await page.unroute('**/connectors/kubernetes**');
      console.log(`PASS Kubernetes duplicate correction ${width} ${theme}`);
    }
  }
}
