import type { Page } from 'playwright';
import type { Shot } from './shots';

/** Capture only after the requested relationship mode has real nodes and routed arrows. */
export async function prepareTopologyCapture(page: Page, options: NonNullable<Shot['topology']>) {
  const map = page.getByRole('region', { name: 'Discovered topology map', exact: true });
  await map.getByRole('button', { name: options.mode, exact: true }).click();
  const canvas = map.getByRole('group', { name: 'Topology relationships', exact: true });
  await canvas.locator('[data-map-node]').first().waitFor({ state: 'visible' });
  // Horizontal SVG paths have zero bounding-box height but still render a stroked arrow.
  await canvas.locator('path[marker-end]').first().waitFor({ state: 'attached' });
  await map.getByRole('button', { name: 'Fit all', exact: true }).click();
  if (options.inspector) {
    // A routed SVG group's bounding-box center need not intersect the painted arrow.
    await canvas
      .getByRole('button', { name: /orders-service → calls → inventory-service/ })
      .press('Enter');
    await map.getByText('Connection attempt recorded', { exact: false }).waitFor();
    await map.getByRole('link', { name: 'Open Datadog log evidence' }).waitFor();
    await map.getByRole('button', { name: 'Fit all', exact: true }).click();
  }
}
