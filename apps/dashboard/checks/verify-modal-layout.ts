import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyGitLabFlow } from './gitlab-flow';
import { verifyGitHubRecovery } from './github-recovery';
import { verifyGitLabStrategies } from './gitlab-strategies';
import { verifyKubernetesErrors } from './kubernetes-errors';

const root = process.cwd();
const artifacts = resolve(root, '.git/codex/artifacts/modal-layout');
await mkdir(artifacts, { recursive: true });
const server = await createServer({
  root: resolve(root, 'apps/dashboard'),
  configFile: resolve(root, 'apps/dashboard/vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  plugins: [
    {
      name: 'modal-layout-fixture',
      configureServer(vite) {
        vite.middlewares.use('/__modal-layout', async (_request, response, next) => {
          try {
            const html = await vite.transformIndexHtml(
              '/__modal-layout',
              `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="/@fs/${root}/apps/dashboard/checks/__tests__/modal-layout.fixture.tsx"></script></body></html>`,
            );
            response.setHeader('Content-Type', 'text/html');
            response.end(html);
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
});
await server.listen();
const address = server.httpServer!.address();
if (!address || typeof address === 'string') throw new Error('No browser test port');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${address.port}/__modal-layout`);
  for (const [width, height] of [
    [360, 800],
    [768, 900],
    [1440, 900],
    [1280, 600],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      for (const size of ['compact', 'standard', 'wide']) {
        await page.getByLabel('Dialog size').selectOption(size);
        await page.getByRole('button', { name: 'Open dialog', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: 'Continue', exact: true }).waitFor();
        const measure = () =>
          dialog.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const footer = element.querySelector('footer')!.getBoundingClientRect();
            const nav = element.querySelector('nav')!.getBoundingClientRect();
            const body = element.querySelector('[data-dialog-body]')!;
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
              footer: footer.bottom,
              nav: nav.top,
              doc: document.documentElement.scrollWidth,
              width: innerWidth,
              height: innerHeight,
              overflow: body.scrollHeight > body.clientHeight,
            };
          });
        const before = await measure();
        const whitespace = await dialog
          .locator('pre')
          .evaluate((element) => getComputedStyle(element).whiteSpace);
        if (whitespace !== 'pre') throw new Error('Command text wraps or breaks words');
        await page.screenshot({
          path: resolve(artifacts, `${size}-${width}-${height}-${theme}-top.png`),
        });
        if (
          before.left < 0 ||
          before.right > width! ||
          before.top < 0 ||
          before.bottom > height! ||
          before.doc > width! ||
          !before.overflow
        )
          throw new Error(`Invalid ${size} modal bounds: ${JSON.stringify(before)}`);
        await dialog
          .locator('[data-dialog-body]')
          .evaluate((element) => (element.scrollTop = element.scrollHeight));
        const after = await measure();
        if (Math.abs(after.footer - before.footer) > 1 || Math.abs(after.nav - before.nav) > 1)
          throw new Error('Navigation or actions scrolled away');
        await page.screenshot({
          path: resolve(artifacts, `${size}-${width}-${height}-${theme}.png`),
        });
        await dialog.getByRole('button', { name: 'Close', exact: true }).focus();
        await page.keyboard.press('Shift+Tab');
        // Native dialogs may visit browser chrome before wrapping, but not the inert page.
        if (await page.evaluate(() => document.activeElement === document.body))
          await page.keyboard.press('Shift+Tab');
        if (
          !(await dialog
            .getByRole('button', { name: 'Continue', exact: true })
            .evaluate((element) => document.activeElement === element))
        )
          throw new Error('Keyboard focus did not return to the last dialog action');
        await page
          .getByRole('button', { name: 'Open dialog', exact: true })
          .evaluate((element) => element.focus());
        if (
          await page
            .getByRole('button', { name: 'Open dialog', exact: true })
            .evaluate((element) => document.activeElement === element)
        )
          throw new Error('Background page accepted focus while the dialog was open');
        await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
        await dialog.getByText('Step 2 of 5 · Projects', { exact: true }).waitFor();
        const nextStep = await measure();
        if (
          Math.abs(nextStep.top - before.top) > 1 ||
          Math.abs(nextStep.bottom - before.bottom) > 1
        )
          throw new Error('Wizard height changed between steps');
        if (
          await dialog.locator('[data-dialog-body]').evaluate((element) => element.scrollTop !== 0)
        )
          throw new Error('New step retained the previous scroll position');
        await page.keyboard.press('Escape');
        if (await dialog.count()) throw new Error('Escape did not close the modal');
        if (
          !(await page
            .getByRole('button', { name: 'Open dialog', exact: true })
            .evaluate((element) => document.activeElement === element))
        )
          throw new Error('Focus was not restored');
        console.log(`PASS ${size} ${width}x${height} ${theme}`);
      }
    }
  }
  await verifyGitLabFlow(page, `http://127.0.0.1:${address.port}`, artifacts);
  await verifyGitLabStrategies(page, `http://127.0.0.1:${address.port}`, artifacts);
  await verifyGitHubRecovery(page, `http://127.0.0.1:${address.port}`, artifacts);
  await verifyKubernetesErrors(page, `http://127.0.0.1:${address.port}`, artifacts);
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
  await server.close();
}
