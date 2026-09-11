import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const migrationPath = fileURLToPath(
  new URL('../../migrations/0024_acoustic_banshee.sql', import.meta.url),
);

describe('model-directed recovery scheduling migration', () => {
  test('adds nullable incident state and a due-time gate without rewriting existing rows', async () => {
    const migration = await readFile(migrationPath, 'utf8');

    for (const column of [
      'recovery_attempt',
      'recovery_max_checks',
      'recovery_next_check_at',
      'recovery_schedule_reason',
    ]) {
      expect(migration).toContain(`ADD COLUMN "${column}"`);
    }
    expect(migration).toContain(
      'ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL',
    );
    expect(migration).toContain('CREATE INDEX "jobs_due_idx"');
    expect(migration).toContain("'monitoring'");
    expect(migration).not.toMatch(/\bUPDATE\s+"?incidents"?|\bDELETE\s+FROM\s+"?incidents"?/i);
  });
});
