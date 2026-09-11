import type { Page } from 'playwright';
import { resolve } from 'node:path';

export async function verifyGitLabStrategies(page: Page, base: string, artifacts: string) {
  for (const strategy of ['group', 'system', 'managed_projects'])
    for (const width of [360, 1440])
      for (const theme of ['light', 'dark']) {
        const managed = strategy === 'managed_projects';
        const choice = managed
          ? /Project hooks Every/
          : strategy === 'system'
            ? /System hook \+ polling/
            : /Group hook/;
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
        await page.getByRole('button', { name: 'Check access and discover projects' }).click();
        await page.getByText('69 projects discovered').waitFor();
        await page.getByRole('button', { name: 'Configure event sync' }).click();
        await page
          .getByRole('radio', {
            name: choice,
          })
          .check();
        if (managed)
          await page.getByRole('checkbox', { name: /Automatically manage project hooks/ }).check();
        await page.getByRole('radio', { name: /Smee relay/ }).check();
        if (!managed) await page.getByText('Set up webhooks in GitLab', { exact: true }).waitFor();
        if (strategy === 'system') {
          const guide = page.getByRole('region', { name: 'System hook form guide' });
          await guide.getByText('Secret token is not the signing token', { exact: true }).waitFor();
          if (
            (await guide
              .getByRole('link', { name: "Open this GitLab instance's system hooks" })
              .getAttribute('href')) !== 'https://gitlab.example.com/admin/hooks'
          )
            throw Error('Wrong system-hook admin link');
          await page.evaluate(() =>
            Object.defineProperty(navigator, 'clipboard', {
              configurable: true,
              value: {
                writeText: async (value: string) => {
                  document.documentElement.dataset.copiedFixtureValue = value;
                },
              },
            }),
          );
          await guide.getByRole('button', { name: 'Copy URL' }).click();
          const copied = await page.evaluate(
            () => document.documentElement.dataset.copiedFixtureValue,
          );
          if (!copied?.startsWith('https://smee.io/'))
            throw Error('System-hook URL copy did not use the relay');
          await guide.getByText('Use these values', { exact: true }).scrollIntoViewIfNeeded();
          await page.screenshot({
            path: resolve(artifacts, `gitlab-system-form-guide-${width}-${theme}.png`),
          });
        }
        if (!managed) {
          await page
            .getByText('Preview installation command (run after saving)', { exact: true })
            .click();
          const command = await page
            .getByLabel('install-hook command', { exact: true })
            .textContent();
          if (!command?.includes(strategy === 'system' ? "'hooks'" : 'groups/7/hooks'))
            throw Error('Wrong strategy installation endpoint');
          if (
            strategy === 'system' &&
            (command.includes('pipeline_events') || command.includes('for project_id'))
          )
            throw Error('System hook falsely claims CI/CD webhook coverage');
        }
        const dialog = page.getByRole('dialog');
        if (
          !(await dialog.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const body = element.querySelector('[data-dialog-body]')!;
            return (
              rect.left >= 0 &&
              rect.right <= innerWidth &&
              rect.bottom <= innerHeight &&
              body.scrollWidth <= body.clientWidth
            );
          }))
        )
          throw Error('GitLab strategy dialog overflows');
        await page.screenshot({
          path: resolve(artifacts, `gitlab-${strategy}-${width}-${theme}.png`),
        });
        await dialog.locator('[data-dialog-body]').evaluate((element) => {
          element.scrollTop = 0;
        });
        await page.screenshot({
          path: resolve(artifacts, `gitlab-${strategy}-choices-${width}-${theme}.png`),
        });
        await page.getByRole('button', { name: 'Review', exact: true }).click();
        await page.getByRole('button', { name: 'Back', exact: true }).click();
        if (
          !(await page
            .getByRole('radio', {
              name: choice,
            })
            .isChecked())
        )
          throw Error('Back lost the selected strategy');
        await page.getByRole('button', { name: 'Review', exact: true }).click();
        await page.getByRole('button', { name: 'Save and verify', exact: true }).click();
        if (managed) {
          await page
            .getByText('Management not authorized for the current configuration', { exact: true })
            .waitFor();
          await page.getByRole('button', { name: 'Review management scope' }).click();
          await page.getByText(/Planned project actions/).click();
          await page.getByText(/not a live GitLab diff/).waitFor();
          const approve = page.getByRole('button', { name: 'Authorize automatic hooks' });
          if (!(await approve.isDisabled()))
            throw Error('Management must require explicit approval');
          await page.getByLabel('Management access token').fill('fixture-management-token');
          if (!(await approve.isDisabled())) throw Error('A token alone must not authorize writes');
          await page.getByRole('checkbox', { name: /I authorize ongoing creation/ }).check();
          await approve.scrollIntoViewIfNeeded();
          if (
            !(await dialog.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              const body = element.querySelector('[data-dialog-body]')!;
              return (
                rect.left >= 0 &&
                rect.right <= innerWidth &&
                rect.bottom <= innerHeight &&
                body.scrollWidth <= body.clientWidth
              );
            }))
          )
            throw Error('Expanded management approval overflows');
          await page.screenshot({
            path: resolve(artifacts, `gitlab-managed-approval-${width}-${theme}.png`),
          });
          await approve.click();
          await page.getByText('Management authorized', { exact: true }).waitFor();
          await page
            .getByText(
              '69 covered · 0 confirmed missing · 0 pending · 0 needing attention · 69 known projects',
              {
                exact: true,
              },
            )
            .waitFor();
          if (await page.getByLabel('Management access token').count())
            throw Error('Approved token input must be cleared');
          await page.getByRole('button', { name: 'Stop management' }).click();
          await page
            .getByText('Management stopped. Existing GitLab hooks were not removed.', {
              exact: true,
            })
            .waitFor();
          await page
            .getByText('Management not authorized for the current configuration', { exact: true })
            .waitFor();
        } else await page.getByText('Finish GitLab event delivery', { exact: true }).waitFor();
        const saved = JSON.parse(
          (await page.getByLabel('Saved GitLab settings').textContent()) ?? '{}',
        );
        if (saved.eventStrategy !== strategy || saved.eventTransport !== 'smee')
          throw Error('Strategy or transport not saved');
        await page.getByRole('button', { name: 'Finish', exact: true }).click();
        if (await page.getByRole('dialog').count()) throw Error('Finish did not close the wizard');
        console.log(`PASS GitLab ${strategy}-strategy ${width}px ${theme}`);
      }
}
