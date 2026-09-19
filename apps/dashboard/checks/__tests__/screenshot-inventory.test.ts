import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'vitest';
import { screenshotPlan, WIZARDS } from '../../../../scripts/docs/screenshots/shots';

test('every registered screenshot exists, with no duplicate names or obsolete images', () => {
  const directory = resolve('docs/assets/screenshots');
  const expected = screenshotPlan([]).matrix.flatMap((size) =>
    size.themes.flatMap((theme) => [
      ...size.shots.map(
        (shot) => `${shot.file}${size.name === 'desktop' ? '' : `-${size.name}`}-${theme}.png`,
      ),
      ...(size.name === 'desktop'
        ? WIZARDS.flatMap((wizard) => wizard.steps.map((step) => `${step.file}-${theme}.png`))
        : []),
    ]),
  );
  expect(new Set(expected).size).toBe(expected.length);
  expect(
    readdirSync(directory)
      .filter((name) => name.endsWith('.png'))
      .sort(),
  ).toEqual(expected.sort());
  for (const name of expected) {
    const image = readFileSync(resolve(directory, name));
    expect(image.subarray(0, 8).toString('hex'), name).toBe('89504e470d0a1a0a');
  }
});
