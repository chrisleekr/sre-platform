import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const css = readFileSync(resolve('apps/dashboard/src/index.css'), 'utf8');

test('the shared shape and typography contract cannot drift silently', () => {
  expect(css).toMatch(/--radius-control:\s*0\.25rem;/);
  expect(css).toMatch(/--radius-card:\s*0\.5rem;/);
  expect(css).toMatch(/--font-weight-medium:\s*510;/);
  expect(css).toMatch(/--font-weight-semibold:\s*590;/);
  expect(css).toContain("@import '@fontsource-variable/inter'");
  for (const control of ['sre-action', 'sre-field']) {
    const declarations = css.match(new RegExp(`\\.${control} \\{([^}]+)\\}`))?.[1];
    expect(declarations).toContain('border-radius: var(--radius-control)');
  }
  for (const radius of ['lg', 'xl', '2xl', '3xl'])
    expect(css).toContain(`--radius-${radius}: var(--radius-card)`);
  expect(css).not.toContain('!important');
});

function palette(theme: 'light' | 'dark'): Map<string, string> {
  const body = css.match(new RegExp(`\\[data-theme='${theme}'\\] \\{([^}]+)\\}`))?.[1];
  if (!body) throw new Error(`Missing ${theme} palette`);
  return new Map(
    [...body.matchAll(/--sre-([\w-]+):\s*(#[\da-f]{6});/g)].map((match) => [match[1]!, match[2]!]),
  );
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map((channel) => {
      const value = parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(colors: Map<string, string>, foreground: string, background: string): number {
  const a = colors.get(foreground);
  const b = colors.get(background);
  if (!a || !b) throw new Error(`Missing token: ${foreground} or ${background}`);
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe.each(['light', 'dark'] as const)('%s design tokens', (theme) => {
  const colors = palette(theme);
  const surfaces = ['canvas', 'surface', 'surface-subtle', 'surface-strong'];

  test.each(['ink', 'ink-secondary', 'ink-muted', 'ink-faint'])(
    '%s remains readable on every neutral surface',
    (foreground) => {
      for (const background of surfaces) {
        expect(
          contrast(colors, foreground, background),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  test.each(['critical', 'warning', 'success', 'info', 'assessment'])(
    '%s remains readable on its status surfaces',
    (status) => {
      for (const background of ['canvas', 'surface', `${status}-soft`, `${status}-muted`]) {
        expect(
          contrast(colors, status, background),
          `${status} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  test('focus and control boundaries are distinct from their surroundings', () => {
    for (const background of surfaces) {
      expect(
        contrast(colors, 'focus', background),
        `focus on ${background}`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrast(colors, 'line-strong', background),
        `control on ${background}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  test('the two-colour focus indicator remains visible on inverted surfaces', () => {
    expect(contrast(colors, 'focus', 'focus-contrast')).toBeGreaterThanOrEqual(9);
    for (const background of ['strong', 'code', 'code-muted']) {
      expect(
        Math.max(
          contrast(colors, 'focus', background),
          contrast(colors, 'focus-contrast', background),
        ),
      ).toBeGreaterThanOrEqual(3);
    }
    expect(css).toContain('box-shadow: 0 0 0 5px var(--sre-focus-contrast)');
  });

  test('both palettes expose the same semantic roles', () => {
    expect([...colors.keys()].sort()).toEqual(
      [...palette(theme === 'light' ? 'dark' : 'light').keys()].sort(),
    );
  });
});
