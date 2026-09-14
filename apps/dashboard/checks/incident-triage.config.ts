import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['apps/dashboard/checks/__tests__/incident-triage.browser.ts'],
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
