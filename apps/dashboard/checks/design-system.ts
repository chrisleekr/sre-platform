import type { Page } from 'playwright';

/** Checks generated CSS on a real dialog, rather than trusting class names in DOM tests. */
export async function verifyDesignSystem(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const coarsePointer = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
  const dialog = page.getByRole('dialog');
  const action = dialog.getByRole('button', { name: 'Continue', exact: true });
  const appearance = await action.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      radius: style.borderRadius,
      border: style.borderTopWidth,
      background: style.backgroundColor,
      weight: style.fontWeight,
      font: style.fontFamily,
      height: element.getBoundingClientRect().height,
    };
  });
  if (
    appearance.radius !== '4px' ||
    appearance.border !== '1px' ||
    appearance.background !== 'rgba(0, 0, 0, 0)' ||
    appearance.weight !== '510' ||
    !appearance.font.includes('Inter Variable') ||
    appearance.height < (coarsePointer ? 44 : 36)
  )
    throw new Error(`Action styles diverged: ${JSON.stringify(appearance)}`);

  await page.keyboard.press('Tab');
  await action.focus();
  const focus = await action.evaluate((element) => {
    const style = getComputedStyle(element);
    return { visible: element.matches(':focus-visible'), width: style.outlineWidth };
  });
  if (!focus.visible || focus.width !== '2px') throw new Error('Action focus is not visible');

  const evidence = dialog.getByRole('link', { name: 'Investigation evidence', exact: true });
  await evidence.focus();
  const invertedFocus = await evidence.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      visible: element.matches(':focus-visible'),
      outline: style.outlineColor,
      width: style.outlineWidth,
      shadow: style.boxShadow,
      dark: document.documentElement.dataset.theme === 'dark',
    };
  });
  const outline = invertedFocus.dark ? 'rgb(247, 248, 248)' : 'rgb(52, 52, 58)';
  const halo = invertedFocus.dark ? 'rgb(8, 9, 10)' : 'rgb(255, 255, 255)';
  if (
    !invertedFocus.visible ||
    invertedFocus.width !== '2px' ||
    invertedFocus.outline !== outline ||
    invertedFocus.shadow !== `${halo} 0px 0px 0px 5px`
  )
    throw new Error(`Inverted focus is not visible: ${JSON.stringify(invertedFocus)}`);

  const disabled = await dialog
    .getByRole('button', { name: 'Back', exact: true })
    .evaluate((element) => ({
      disabled: element.hasAttribute('disabled'),
      opacity: getComputedStyle(element).opacity,
    }));
  if (!disabled.disabled || disabled.opacity !== '0.5')
    throw new Error('Disabled action lost its state');

  const field = await dialog.getByLabel('Field 1', { exact: true }).evaluate((element) => ({
    radius: getComputedStyle(element).borderRadius,
    height: element.getBoundingClientRect().height,
    fontSize: getComputedStyle(element).fontSize,
  }));
  if (
    field.radius !== '4px' ||
    field.height < (coarsePointer ? 44 : 40) ||
    (coarsePointer && field.fontSize !== '16px')
  )
    throw new Error(`Field styles diverged: ${JSON.stringify(field)}`);
  const panel = await dialog.evaluate((element) => ({
    shadow: getComputedStyle(element).boxShadow,
    radius: getComputedStyle(element).borderRadius,
  }));
  if (panel.shadow !== 'none' || panel.radius !== '8px')
    throw new Error('Dialog elevation diverged');
}
