import type { Page } from 'playwright';
import { resolve } from 'node:path';

export async function verifyGitLabFlow(page: Page, base: string, artifacts: string) {
  for (const width of [360, 1440])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/__modal-layout?scenario=gitlab`);
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.getByLabel('GitLab URL', { exact: true }).fill('https://gitlab.example.com');
      await page.getByLabel('Top-level group full path').fill('platform');
      await page.getByLabel('Read-only access token', { exact: false }).fill('fixture-token');
      await page.getByRole('button', { name: 'Check access and discover projects' }).click();
      await page.getByRole('alert').filter({ hasText: 'Retry discovery' }).waitFor();
      if (
        (await page.getByLabel('Read-only access token', { exact: false }).inputValue()) !==
        'fixture-token'
      )
        throw Error('Retry lost the credential');
      await page.getByRole('button', { name: 'Check access and discover projects' }).click();
      await page.getByText('69 projects discovered').waitFor();
      await page.getByRole('button', { name: 'Configure event sync' }).click();
      await page.getByRole('radio', { name: /Smee relay/ }).check();
      await page.getByText('Set up webhooks in GitLab', { exact: true }).waitFor();
      await page.getByText('Where are webhooks in GitLab?', { exact: true }).click();
      await page.getByLabel('Find project webhook settings').fill('service-69');
      const link = page.getByRole('link', { name: 'platform/service-69 → Webhooks' });
      if (
        (await link.getAttribute('href')) !==
        'https://gitlab.example.com/platform/service-69/-/hooks'
      )
        throw Error('Wrong project settings URL');
      await page
        .getByText('Preview installation command (run after saving)', { exact: true })
        .click();
      const preview = await page.getByLabel('install-hook command', { exact: true }).textContent();
      if (!preview?.includes('for project_id in 1 2 3') || preview.includes('fixture-token'))
        throw Error('Invalid hook command preview');
      const dialog = page.getByRole('dialog');
      await dialog.locator('[data-dialog-body]').evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const valid = await dialog.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const body = element.querySelector('[data-dialog-body]')!;
        return (
          rect.left >= 0 &&
          rect.right <= innerWidth &&
          rect.bottom <= innerHeight &&
          body.scrollWidth <= body.clientWidth &&
          document.documentElement.scrollWidth <= innerWidth
        );
      });
      if (!valid) throw Error('GitLab wizard overflow');
      await page.screenshot({ path: resolve(artifacts, `gitlab-events-${width}-${theme}.png`) });
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByText('Set up webhooks in GitLab', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await page.getByRole('button', { name: 'Save and verify', exact: true }).click();
      await page.getByText('Finish GitLab event delivery', { exact: true }).waitFor();
      if (
        (await page.getByLabel('install-hook command', { exact: true }).textContent()) !== preview
      )
        throw Error('Saved hook identity changed from its preview');
      await page.getByText(/Delivery is not verified by this access check/).waitFor();
      await page.screenshot({ path: resolve(artifacts, `gitlab-verify-${width}-${theme}.png`) });
      await page.getByRole('button', { name: 'Edit configuration', exact: true }).click();
      await page.getByLabel('GitLab URL', { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      if (await page.getByRole('dialog').count()) throw Error('GitLab wizard did not close');
      console.log(`PASS GitLab failure-retry-events-save-edit ${width}px ${theme}`);
    }
}
