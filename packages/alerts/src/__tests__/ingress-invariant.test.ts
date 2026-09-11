// Every incident is born through one atomic workspace opener. Slack is an adapter and a dashboard
// observation may have no remote thread, but both must commit incident, evidence, opener, and work together.
//
// Deliberately a source scan, not a runtime assertion. A direct caller is a design decision (it needs
// explicit review and sign-off on the merge request), and the point is to fail at review time with a
// named file, not at 3am.
//
// The scan covers the whole ingress surface, not just the row writer: `createIncident` mints the row,
// `openIncidentWorkspace` is the atomic opener, and `routeToIncident` is the Slack adapter onto it.
// A module that reaches any of the three is an ingress, whatever it calls itself, which is what keeps
// a read model such as the error budget from quietly growing one.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCAN_ROOTS = ['apps', 'packages'];
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.claude',
  'migrations',
  '__tests__',
]);

/**
 * The complete ingress surface, one allow-list per symbol. Every entry was derived from a scan of the
 * tree, so an addition here is a deliberate act: it means a new module may open incidents.
 */
const INGRESS = [
  {
    // Its definition and the shared workspace opener. Nothing else may mint an incident row.
    symbol: 'createIncident',
    allowed: [
      'packages/alerts/src/open-incident-workspace.ts',
      'packages/db/src/incident-repo/create.ts',
    ],
  },
  {
    // Its definition, the Slack adapter, and the two dashboard-declaration routes.
    symbol: 'openIncidentWorkspace',
    allowed: [
      'apps/api/src/incident-observations.ts',
      'apps/api/src/incidents/list.ts',
      'packages/alerts/src/open-incident-workspace.ts',
      'packages/alerts/src/route-to-incident.ts',
    ],
  },
  {
    // Its definition plus the three inbound conversation paths that adapt onto it.
    symbol: 'routeToIncident',
    allowed: [
      'apps/api/src/alertmanager-webhook/processor.ts',
      'apps/api/src/signals.ts',
      'apps/triage-worker/src/classify-consumer/core.ts',
      'packages/alerts/src/route-to-incident.ts',
    ],
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

describe('single incident workspace opener', () => {
  const sources = SCAN_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)));

  test('the scan actually reaches the workspaces it claims to cover', () => {
    // Guards against a silently empty walk turning every assertion below into a vacuous pass.
    const relativePaths = sources.map((file) => relative(REPO_ROOT, file).split('\\').join('/'));
    expect(relativePaths).toContain('packages/alerts/src/open-incident-workspace.ts');
    expect(relativePaths.some((file) => file.startsWith('apps/'))).toBe(true);
  });

  for (const { symbol, allowed } of INGRESS) {
    test(`${symbol} is called only from the declared ingress`, () => {
      const pattern = new RegExp(`\\b${symbol}\\s*\\(`);
      const callers = sources
        .filter((file) => pattern.test(readFileSync(file, 'utf8')))
        .map((file) => relative(REPO_ROOT, file).split('\\').join('/'))
        .sort();

      // A new entry here bypasses atomic subject, conversation, and job creation.
      expect(callers).toEqual(allowed.slice().sort());
    });
  }
});
