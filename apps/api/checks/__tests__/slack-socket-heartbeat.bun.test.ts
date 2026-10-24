import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import * as undici from 'undici';

const require = createRequire(import.meta.url);
const socketModePackage = require('@slack/socket-mode/package.json') as {
  version: string;
  dependencies?: Record<string, string>;
};

test('selected Socket Mode heartbeat transport is executable under Bun', () => {
  const major = Number.parseInt(socketModePackage.version.split('.')[0] ?? '', 10);
  const undiciPing = (undici as unknown as { ping?: unknown }).ping;

  // Passing does not make Socket Mode 3 safe on Bun. See the Socket Mode cap in CONTRIBUTING.md.
  expect(
    major >= 3 && typeof undiciPing !== 'function',
    `@slack/socket-mode ${socketModePackage.version} calls undici.ping for heartbeats, but Bun ${Bun.version} does not expose that function (Bun 1.4.4 added it). Select the v2 ws transport instead.`,
  ).toBe(false);
  if (major < 3) {
    expect(
      socketModePackage.dependencies?.ws,
      'Socket Mode v2 must retain its ws heartbeat transport',
    ).toMatch(/^\^?8(?:\.|$)/);
  }
});
