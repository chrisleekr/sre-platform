import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('0020 adds nullable decision and citation fields without rewriting historical incidents', async () => {
  const migration = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', '0020_kind_leader.sql'),
    'utf8',
  );

  for (const column of [
    'current_state',
    'impact',
    'assessment_evidence_ids',
    'recovery_evidence_ids',
    'recovery_unknowns',
    'recovery_next_step',
  ]) {
    expect(migration).toContain(`ADD COLUMN "${column}"`);
  }
  expect(migration).not.toMatch(/\bNOT NULL\b|\bDEFAULT\b|\bUPDATE\s+"?incidents"?/i);
});
