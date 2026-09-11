import { defineConfig } from 'vitest/config';
import base from '../../../vitest.config';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['apps/dashboard/checks/__tests__/gitlab-integration.browser.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
