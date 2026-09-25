import { expect, test } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

test('triage reflows and evidence navigation preserves the responder context', async () => {
  const child = spawn('bun', ['apps/dashboard/checks/incident-triage-browser.mjs'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // An unread pipe can fill and block the fixture; keep the output to explain a failed startup.
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let browser: Browser | undefined;
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Fixture startup timed out\n${stderr}`)),
        30_000,
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
        const match = /Incident fixture: (http:\/\/[^\s]+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Fixture exited ${code}\n${stderr}`));
      });
    });
    const fixture = { url };
    browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
      reducedMotion: 'reduce',
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(fixture.url);
    await page.getByText('Live updates: open', { exact: true }).waitFor();
    await page.getByText('Initial responder context', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: /new conversation update/ }).count()).toBe(0);
    expect(await page.getByRole('button', { name: /Connection restored/ }).count()).toBe(0);
    const main = page.locator('#main-content');
    const composer = page.getByLabel('Ask the SRE', { exact: true });
    await composer.fill('Preserve this diagnostic question');
    const sizes = [
      [320, 568],
      [360, 800],
      [390, 844],
      [844, 390],
      [768, 1024],
      [820, 1180],
      [1024, 768],
      [1180, 820],
      [1280, 720],
      [1440, 900],
      [1920, 1080],
      [767, 900],
      [769, 900],
      [1023, 900],
      [1025, 900],
      [943, 900],
      [944, 900],
      [945, 900],
      [1183, 900],
      [1184, 900],
      [1185, 900],
    ];
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width: width!, height: height! });
      expect(await main.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
        true,
      );
      expect(await composer.inputValue()).toBe('Preserve this diagnostic question');
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: /All evidence/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Evidence ledger' });
    await dialog.waitFor();
    const backgroundTop = await main.evaluate((element) => element.scrollTop);
    await page.mouse.move(1274, 360);
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(100);
    expect(await main.evaluate((element) => element.scrollTop)).toBe(backgroundTop);
    await dialog.getByRole('button', { name: 'Load older evidence' }).click();
    await dialog.getByText(/40 loaded records/).waitFor();
    await dialog.getByLabel('Search loaded evidence').fill('checkout-api-7d9f');
    await dialog.getByRole('button', { name: /Argo CD/ }).click();
    await dialog.getByLabel('Logs', { exact: true }).waitFor();
    expect(await dialog.getByLabel('Logs', { exact: true }).textContent()).toContain('<untrusted>');
    await dialog.getByRole('button', { name: 'Next Logs page' }).click();
    await page.request.get(new URL('/__api/publish', fixture.url).toString());
    expect(await composer.inputValue()).toBe('Preserve this diagnostic question');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    const scrollers = await dialog.evaluate(
      (element) =>
        [...element.querySelectorAll('*')].filter(
          (candidate) =>
            /auto|scroll/.test(getComputedStyle(candidate).overflowY) &&
            candidate.scrollHeight > candidate.clientHeight + 2,
        ).length,
    );
    expect(scrollers).toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    expect(await dialog.count()).toBe(0);
    expect(
      await page
        .getByRole('button', { name: /All evidence/ })
        .evaluate((element) => element === document.activeElement),
    ).toBe(true);
    expect(await composer.inputValue()).toBe('Preserve this diagnostic question');
    await page.getByRole('button', { name: /new conversation update/ }).waitFor();
    await page.getByRole('button', { name: 'Disconnect stream', exact: true }).click();
    await page.getByText('Live updates: closed', { exact: true }).waitFor();
    await composer.fill('I can keep composing during a disconnect');
    expect(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled()).toBe(true);
    await main.evaluate((element) => {
      element.scrollTop = 0;
    });
    const readingPosition = await main.evaluate((element) => element.scrollTop);
    await page.request.get(new URL('/__api/publish', fixture.url).toString());
    await page.getByRole('button', { name: 'Retry live updates', exact: true }).click();
    await page.getByText('Live updates: open', { exact: true }).waitFor();
    await page.getByText('New responder evidence 2', { exact: true }).waitFor();
    const reconnectReview = page.getByRole('button', {
      name: '1 new conversation update · Connection restored · Review conversation',
      exact: true,
    });
    await reconnectReview.waitFor();
    expect(await composer.inputValue()).toBe('I can keep composing during a disconnect');
    expect(await main.evaluate((element) => element.scrollTop)).toBe(readingPosition);
    await page.request.get(new URL('/__api/disconnect', fixture.url).toString());
    await page.getByText('Live updates: closed', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Retry live updates', exact: true }).click();
    await page.getByText('Live updates: open', { exact: true }).waitFor();
    await reconnectReview.waitFor();
    expect(await page.getByText('New responder evidence 2', { exact: true }).count()).toBe(1);
    await reconnectReview.click();
    expect(await reconnectReview.count()).toBe(0);
    expect(await composer.inputValue()).toBe('I can keep composing during a disconnect');
    const allEvidence = page.getByRole('button', { name: /All evidence/ });
    await allEvidence.focus();
    await page.keyboard.press('Enter');
    await dialog.waitFor();
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await dialog.getByRole('button', { name: 'Close', exact: true }).focus();
    await page.keyboard.press('Space');
    expect(await dialog.count()).toBe(0);
    await page.goto(`${fixture.url}#evidence-22222222-2222-4222-8222-000000000044`);
    await dialog.getByText(/sample 44/).waitFor();
    await page.setViewportSize({ width: 844, height: 390 });
    expect(await dialog.getByRole('button', { name: 'Back to evidence' }).isVisible()).toBe(true);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    expect(page.url()).not.toContain('#evidence-');
    const citation = page
      .getByRole('link', {
        name: 'Open evidence 22222222-2222-4222-8222-000000000001',
        exact: true,
      })
      .first();
    await citation.click();
    await dialog.waitFor();
    await page.goBack();
    expect(await dialog.count()).toBe(0);
    await page.goForward();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await page.goto(`${fixture.url}#evidence-not-a-uuid`);
    await page.getByRole('heading', { name: /Checkout requests/ }).waitFor();
    expect(await dialog.count()).toBe(0);
    await page.goto(`${fixture.url}?long=true`);
    await page.getByRole('heading', { name: /Checkout requests/ }).waitFor();
    await page.setViewportSize({ width: 320, height: 568 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    expect(await main.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '';
    });
    // .vitest/ is ignored, so reviewing screenshots never leaves files for a later `git add -A`.
    await mkdir('.vitest/incident-triage-browser', { recursive: true });
    for (const [name, width, height] of [
      ['mobile', 390, 844],
      ['tablet', 820, 1180],
      ['desktop', 1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await main.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.screenshot({ path: `.vitest/incident-triage-browser/${name}.png` });
    }
    for (const theme of ['light', 'dark']) {
      await page.goto(`${fixture.url}?recovered=true`);
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.getByText('Impact at last assessment', { exact: true }).waitFor();
      const impact = page
        .getByText('Checkout requests have elevated errors in ap-southeast-2.', { exact: true })
        .locator('..');
      expect(await impact.locator('time').getAttribute('datetime')).toBe('2026-09-14T00:29:00Z');
      await page
        .getByRole('region', { name: 'Latest investigation result' })
        .getByText('The restart cause remains unproven.', { exact: true })
        .waitFor();
      expect(await page.getByText(/no current impact/i).count()).toBe(0);
      for (const [width, height] of [
        [390, 844],
        [820, 1180],
        [1440, 900],
      ]) {
        await page.setViewportSize({ width: width!, height: height! });
        expect(
          await main.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        ).toBe(true);
      }
      await page.goto(`${fixture.url}?recovered=true&queue=true`);
      await page.getByText('No trusted assessment yet.', { exact: true }).waitFor();
      await page.getByText('The restart cause remains unproven.', { exact: true }).waitFor();
    }
    await page.goto(fixture.url);
    await page.getByText('Manage incident lifecycle', { exact: true }).click();
    const policy = page.getByRole('combobox', { name: 'Resolution policy' });
    const savePolicy = page.getByRole('button', { name: 'Save resolution policy', exact: true });
    await policy.selectOption('provider_clear');
    expect(await savePolicy.isDisabled()).toBe(true);
    await page
      .getByLabel('Lifecycle change reason', { exact: true })
      .fill('The monitor is our agreed recovery criterion.');
    await policy.focus();
    await page.keyboard.press('Tab');
    expect(await savePolicy.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('button') !== null);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(
        (button) => button.textContent === 'Save resolution policy' && button.disabled,
      ),
    );
    const saved = await page.request
      .get(new URL('/__api/policy', fixture.url).toString())
      .then((response) => response.json());
    expect(saved.policyRequest).toMatchObject({
      policy: 'provider_clear',
      expectedVersion: 0,
      reason: 'The monitor is our agreed recovery criterion.',
    });
    expect(saved.policyRequest.requestId).toMatch(/^[0-9a-f-]{36}$/);
    await policy.selectOption('verified_recovery');
    await page.request.get(new URL('/__api/policy-conflict', fixture.url).toString());
    await savePolicy.click();
    await page
      .getByRole('alert')
      .filter({ hasText: 'Incident state changed. Review it and try again.' })
      .waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLSelectElement>('#incident-lifecycle-controls select')?.value ===
        'provider_clear',
    );
    expect(await policy.inputValue()).toBe('provider_clear');
    for (const theme of ['light', 'dark']) {
      await page.goto(`${fixture.url}?provider-resolved=true`);
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page
        .getByRole('heading', { name: 'Resolved from provider signals', exact: true })
        .waitFor();
      await page.getByText('Health not independently verified', { exact: true }).waitFor();
      await page.getByText('Impact at last assessment', { exact: true }).waitFor();
      expect(await page.getByText('Recovery verified', { exact: true }).count()).toBe(0);
      for (const [name, width, height] of [
        ['mobile', 390, 844],
        ['tablet', 820, 1180],
        ['desktop', 1440, 900],
      ] as const) {
        await page.setViewportSize({ width, height });
        expect(
          await main.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        ).toBe(true);
        await page.screenshot({
          path: `.vitest/incident-triage-browser/provider-${theme}-${name}.png`,
        });
      }
      await page.goto(`${fixture.url}?provider-resolved=true&queue=true`);
      await page.getByText('Resolved from provider signals', { exact: true }).waitFor();
      await page.getByText('Health not independently verified', { exact: true }).waitFor();
    }
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    }
  }
});
