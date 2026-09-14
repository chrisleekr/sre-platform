import { defineConfig } from 'vitest/config';
import base from '../../../vitest.config';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: undefined,
    include: ['apps/dashboard/checks/__tests__/ownership.browser.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
    maxWorkers: 1,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
