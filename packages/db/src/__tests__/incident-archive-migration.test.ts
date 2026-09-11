import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('0021 adds reversible incident archival without rewriting historical lifecycle', async () => {
  const migration = await readFile(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'migrations',
      '0021_funny_hemingway.sql',
    ),
    'utf8',
  );

  expect(migration).toContain('ADD COLUMN "archived_at"');
  expect(migration).toContain('incidents_tenant_archived_created_id_idx');
  expect(migration).not.toMatch(/\bUPDATE\s+"?incidents"?|\bDELETE\s+FROM\s+"?incidents"?/i);
  expect(migration).not.toMatch(/"archived_at"[^;]*\bNOT NULL\b/i);
});
