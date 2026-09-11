/// <reference lib="dom" />
import type { Page } from 'playwright';
import { mkdir } from 'node:fs/promises';

/** Checks the current persisted state without replacing routes or response data.
 * @param page - Real onboarding browser page.
 * @param state - Diagnostic name for the current step.
 * @param keyboardTarget - Accessible name of an enabled control that keyboard users must reach.
 * @param savedText - Authoritative values that must finish loading before inspection.
 * @param expectWideFrame - Whether the page belongs to the wide public onboarding journey.
 */
export async function verifyOnboardingLayout(
  page: Page,
  state: string,
  keyboardTarget: string,
  savedText: string[] = [],
  expectWideFrame = true,
) {
  const artifacts = `${process.cwd()}/.git/codex/artifacts/onboarding-layout`;
  await mkdir(artifacts, { recursive: true });
  const frame = page.locator('main > div').nth(1);
  async function ready() {
    for (const text of savedText) await page.getByText(text, { exact: true }).first().waitFor();
    await page
      .getByRole('button', { name: keyboardTarget, exact: true })
      .or(page.getByRole('link', { name: keyboardTarget, exact: true }))
      .or(page.getByLabel(keyboardTarget, { exact: true }))
      .first()
      .waitFor();
    if (
      expectWideFrame &&
      !(await frame.evaluate((element) => element.classList.contains('max-w-6xl')))
    )
      throw new Error(`${state}: onboarding frame is not consistently wide`);
  }
  async function assertTextBounds() {
    for (const text of savedText) {
      const bounds = await page
        .getByText(text, { exact: true })
        .first()
        .evaluate((element) => {
          const card = element.closest('section') ?? element.closest('main') ?? element;
          const box = card.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          return [...range.getClientRects()].map((line) => ({
            left: line.left,
            right: line.right,
            minimum: Math.max(0, box.left),
            maximum: Math.min(window.innerWidth, box.right),
          }));
        });
      if (bounds.some((line) => line.left < line.minimum - 1 || line.right > line.maximum + 1)) {
        throw new Error(
          `${state}: saved text clipped beyond its card: ${text} ${JSON.stringify(bounds)}`,
        );
      }
    }
  }
  for (const [width, height] of [
    [390, 844],
    [574, 1803],
    [768, 1000],
    [1440, 900],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    for (const theme of ['light', 'dark']) {
      await ready();
      const appearance = page.locator('select[aria-label="Appearance"]:visible');
      const themeControl = appearance
        .or(page.getByRole('button', { name: 'Open navigation', exact: true }))
        .first();
      // Wait for a control instead of interpreting a transient remount as a closed sidebar.
      if ((await themeControl.getAttribute('aria-label')) === 'Appearance')
        await appearance.selectOption(theme);
      else {
        await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
        await appearance.selectOption(theme);
        await page.keyboard.press('Escape');
      }
      await ready();
      await assertTextBounds();
      const overflow = await page.evaluate(() => ({
        width: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        offenders: [...document.querySelectorAll('main *')]
          .filter((element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.right > window.innerWidth + 1;
          })
          .slice(0, 8)
          .map((element) => ({ tag: element.tagName, text: element.textContent?.slice(0, 100) })),
      }));
      if (overflow.scrollWidth > width!)
        throw new Error(`${state} overflow ${width}/${theme}: ${JSON.stringify(overflow)}`);
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        window.scrollTo(0, 0);
      });
      let reached = false;
      for (let tab = 0; tab < 45; tab++) {
        await ready();
        await assertTextBounds();
        await page.keyboard.press('Tab');
        reached = await page.evaluate((name) => {
          const active = document.activeElement as HTMLElement | null;
          return (
            active?.getAttribute('aria-label') === name ||
            active?.textContent?.trim() === name ||
            (active instanceof HTMLInputElement &&
              [...(active.labels ?? [])].some((label) => label.textContent?.trim() === name))
          );
        }, keyboardTarget);
        if (reached) break;
      }
      if (!reached)
        throw new Error(`${state}: keyboard did not reach ${keyboardTarget} at ${width}/${theme}`);
      if ((width === 390 && theme === 'light') || (width === 1440 && theme === 'dark')) {
        await ready();
        await page.screenshot({
          path: `${artifacts}/${state.replaceAll(' ', '-')}-${width}-${theme}.png`,
          fullPage: true,
        });
        if (savedText.includes('Verify your domain')) {
          await page
            .getByRole('heading', { name: 'Verify your domain', exact: true })
            .scrollIntoViewIfNeeded();
          await page.screenshot({
            path: `${artifacts}/${state.replaceAll(' ', '-')}-${width}-${theme}-top.png`,
            fullPage: true,
          });
        }
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log(`PASS layout: ${state}, 390/574/768/1440, light/dark, keyboard ${keyboardTarget}`);
}
