import type { Page } from 'playwright';

/** Expands viewport-bound scroll containers for full-page documentation captures. */
export async function captureFullPage(page: Page, path: string): Promise<void> {
  const layout = await page.addStyleTag({
    content: `
    div:has(> div > #main-content) {
      position: relative !important;
      inset: auto !important;
      height: auto !important;
      min-height: 100vh !important;
      overflow: visible !important;
    }
    #main-content, [class*="overflow-y-auto"], [data-dialog-body] {
      height: auto !important;
      max-height: none !important;
      overflow-y: visible !important;
    }
    #main-content { flex: none !important; }
    aside[aria-label="Incident evidence and context"] { position: static !important; }
    dialog[open] {
      position: absolute !important;
      top: 16px !important;
      bottom: auto !important;
      margin: 0 auto !important;
      max-height: none !important;
      overflow: visible !important;
    }
    dialog[open] > div { height: auto !important; max-height: none !important; }
  `,
  });
  let dialogSpace: Awaited<ReturnType<Page['addStyleTag']>> | undefined;
  try {
    const dialog = page.locator('dialog[open]');
    if (await dialog.count()) {
      const height = await dialog.evaluate((element) => element.scrollHeight);
      dialogSpace = await page.addStyleTag({
        content: `body { min-height: ${height + 32}px !important; }`,
      });
    }
    await page.screenshot({ path, fullPage: true });
  } finally {
    await dialogSpace?.evaluate((element) => element.parentNode?.removeChild(element));
    await layout.evaluate((element) => element.parentNode?.removeChild(element));
  }
}
