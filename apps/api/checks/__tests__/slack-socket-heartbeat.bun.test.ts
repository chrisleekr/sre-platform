import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const socketModePackage = require('@slack/socket-mode/package.json') as {
  version: string;
  dependencies?: Record<string, string>;
};

// Renovate's allowedVersions only limits Renovate's own updates, so this enforces the cap for manual installs too.
test('Socket Mode stays on the v2 ws heartbeat transport under Bun', () => {
  const major = Number.parseInt(socketModePackage.version.split('.')[0] ?? '', 10);

  expect(
    major,
    `@slack/socket-mode ${socketModePackage.version} runs on Bun's undici, which cannot capture the socket Socket Mode 3 destroys on cleanup. See the Socket Mode cap in CONTRIBUTING.md.`,
  ).toBeLessThan(3);
  expect(
    socketModePackage.dependencies?.ws,
    'Socket Mode v2 must retain its ws heartbeat transport',
  ).toMatch(/^\^?8(?:\.|$)/);
});
