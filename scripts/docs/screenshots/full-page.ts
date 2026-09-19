import type { Page } from 'playwright';

/** Expands viewport-bound scroll containers for full-page documentation captures. */
export async function captureFullPage(page: Page, path: string): Promise<void> {
  if (await page.locator('dialog[open]').count()) {
    await page.screenshot({ path });
    return;
  }
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
  `,
  });
  try {
    await page.screenshot({ path, fullPage: true });
  } finally {
    await layout.evaluate((element) => element.parentNode?.removeChild(element));
  }
}
