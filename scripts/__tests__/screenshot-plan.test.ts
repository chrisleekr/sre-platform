import { expect, test } from 'vitest';
import { screenshotPlan } from '../docs/screenshots/shots';

function inventory(args: string[]) {
  const plan = screenshotPlan(args);
  return plan.matrix.flatMap((size) =>
    size.shots.flatMap((shot) => size.themes.map((theme) => `${shot.file}-${size.name}-${theme}`)),
  );
}

test('full capture retains every targeted incident asset without adding unrelated tablet shots', () => {
  const full = inventory([]);
  const incident = inventory(['--only=incident']);
  expect(incident).toHaveLength(12);
  expect(full).toEqual(expect.arrayContaining(incident));
  expect(full.filter((file) => file.includes('-tablet-'))).toEqual(
    incident.filter((file) => file.includes('-tablet-')),
  );
});

test('topology-only capture remains isolated from incident and tablet assets', () => {
  expect(
    inventory(['--only=topology']).every(
      (file) => file.startsWith('topology') && !file.includes('-tablet-'),
    ),
  ).toBe(true);
});
