import type { Page } from 'playwright';
import { resolve } from 'node:path';

export async function verifyGitHubRecovery(page: Page, base: string, artifacts: string) {
  for (const width of [360, 1440])
    for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${base}/__modal-layout?scenario=github`);
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.getByText(/Last delivery failed signature validation/).waitFor();
      const field = page.getByLabel('Replacement webhook secret', { exact: true });
      await field.fill('fixture-replacement-secret');
      await page.getByText('Replace private key for API access', { exact: true }).click();
      if (await page.getByLabel('Replacement private key (PEM)', { exact: true }).inputValue())
        throw Error('Saved key was exposed');
      await page.getByRole('region', { name: 'Repair GitHub connection' }).scrollIntoViewIfNeeded();
      const valid = await page.getByRole('dialog').evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const body = element.querySelector('[data-dialog-body]')!;
        return (
          bounds.left >= 0 &&
          bounds.right <= innerWidth &&
          bounds.bottom <= innerHeight &&
          body.scrollWidth <= body.clientWidth
        );
      });
      if (!valid) throw Error('GitHub recovery layout overflows');
      await page.screenshot({ path: resolve(artifacts, `github-repair-${width}-${theme}.png`) });
      for (let attempt = 0; attempt < 2; attempt++) {
        await page.getByRole('button', { name: 'Check current installation', exact: true }).click();
        await page.getByRole('button', { name: 'Review repository coverage', exact: true }).click();
        await page.getByRole('button', { name: 'Review connection', exact: true }).click();
        await page.getByText('Keep saved key', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Save, sync, and verify', exact: true }).click();
        await page
          .getByText(
            attempt === 0
              ? 'GitHub saved but verification failed.'
              : 'GitHub code access verified and repository catalog synchronized.',
            { exact: true },
          )
          .waitFor();
        if (attempt === 0) {
          await page.getByRole('button', { name: 'Edit configuration', exact: true }).click();
          if ((await field.inputValue()) !== 'fixture-replacement-secret')
            throw Error('Recovery lost the unsaved replacement');
        }
      }
      await page
        .getByText(/Event health becomes verified after the first signed delivery/)
        .waitFor();
      await page.getByRole('button', { name: 'Finish', exact: true }).click();
      if (await page.getByRole('dialog').count()) throw Error('Recovery did not finish');
      console.log(`PASS GitHub repair-save-failure-edit-retry ${width}px ${theme}`);
    }
}
