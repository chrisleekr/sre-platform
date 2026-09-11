import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const VITEST_EXCLUDE = [
  ...configDefaults.exclude,
  '**/*.bun.test.{ts,js}',
  '**/*.bun_test.{ts,js}',
];

export default defineConfig({
  // Stays at the root and is inherited by both projects, so the node-environment dashboard files
  // still transform .tsx.
  plugins: [react()],
  test: {
    // globals: true exposes afterEach as a global so @testing-library/react self-registers cleanup()
    // after each test (#86). It only affects files that import testing-library (the jsdom component
    // tests); node backend tests, which never import it, are unchanged. Removes the need for a
    // per-file afterEach(cleanup) and stops component renders accumulating within a file.
    globals: true,
    // The dashboard component tests assert absolute URLs built from these, which a real run reads
    // from .env. `bun run test` never creates one: global setup boots its own Postgres and Valkey and
    // rewrites only those URLs. On a fresh clone VITE_API_BASE_URL is therefore absent, so
    // configured() in apps/dashboard/src/config.ts returns '' and apiBaseUrl becomes the same-origin
    // default. The :3000 appears one step later: absoluteApiUrl resolves the now-relative path
    // against the jsdom page origin, http://localhost:3000, and 15 tests failed on :43000 vs :3000.
    // CI supplies the variables, so the gate passed on an input a new contributor does not have.
    // Pinned here so the CI run and the local run are provably the same run.
    //
    // Both keys config.ts reads, not just the one that was failing: the WS base is derived from the
    // API base today, so pinning only the API base would leave a later WS assertion exposed to the
    // same ambient .env. Values match .env.example.
    env: {
      VITE_API_BASE_URL: 'http://localhost:43000',
      VITE_WS_BASE_URL: 'ws://localhost:43000',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Raised per-package as real code lands (M0-03).
      thresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    },
    // Two projects so a CI lane can run the dashboard suites without paying for the container
    // stack. Neither project sets `root`: apps/dashboard/src/__tests__/theme.test.tsx reads
    // apps/dashboard/index.html relative to process.cwd(), so both stay rooted at the repository
    // root and select purely by `include`. The two include sets must partition the tree exactly,
    // because an overlap double-counts a file in the JSON report the test gate compares.
    projects: [
      {
        extends: true,
        test: {
          name: 'ui',
          include: ['apps/dashboard/**/*.{test,spec}.{ts,tsx,js,jsx}'],
          exclude: VITEST_EXCLUDE,
          // Declares no global setup and no maxWorkers pin. Every file under apps/dashboard
          // reaches only @sre/contracts, which has no dependencies, so this project starts no
          // container and shares no process state.
        },
      },
      {
        extends: true,
        test: {
          name: 'backend',
          include: [
            'apps/**/*.{test,spec}.{ts,tsx,js,jsx}',
            'packages/**/*.{test,spec}.{ts,tsx,js,jsx}',
            'scripts/**/*.{test,spec}.{ts,tsx,js,jsx}',
          ],
          exclude: [...VITEST_EXCLUDE, 'apps/dashboard/**'],
          // Backend suites share one isolated Postgres/Valkey stack, including global control-plane
          // invariants. Serial files prevent one fixture from satisfying another file's safety guard.
          maxWorkers: 1,
          // The only project that declares it. A second would boot the container stack twice and
          // run the migrations twice.
          globalSetup: ['./vitest.global-setup.ts'],
        },
      },
    ],
  },
});
