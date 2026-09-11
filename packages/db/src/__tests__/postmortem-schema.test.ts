import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { makeDb, type DbHandle } from '../index';

// start state: the postmortem, action-item and assessment-grade tables and the two job
// coalescing indexes do not exist yet. Reads the LIVE catalog through raw SQL so this file compiles
// against HEAD without the new schema modules and turns green only once the migration lands.
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';

let admin: DbHandle;

beforeAll(() => {
  admin = makeDb(ADMIN_URL);
});

afterAll(async () => {
  await admin.close();
});

describe('postmortem and assessment-grade schema', () => {
  test('the postmortems, postmortem_action_items and assessment_grades tables exist', async () => {
    const rows = (await admin.db.execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name in ('postmortems', 'postmortem_action_items', 'assessment_grades')
    `)) as unknown as { table_name: string }[];
    expect(rows.map((r) => r.table_name).sort()).toEqual([
      'assessment_grades',
      'postmortem_action_items',
      'postmortems',
    ]);
  });

  test('jobs carries the postmortem and assessment-grade coalescing indexes', async () => {
    const rows = (await admin.db.execute(sql`
      select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'jobs'
        and indexname in ('jobs_postmortem_coalesce_idx', 'jobs_assessment_grade_coalesce_idx')
    `)) as unknown as { indexname: string }[];
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      'jobs_assessment_grade_coalesce_idx',
      'jobs_postmortem_coalesce_idx',
    ]);
  });
});
