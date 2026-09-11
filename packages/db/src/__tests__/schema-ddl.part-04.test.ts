// Characterization lock for the postmortem and RCA-grading DDL: the two generation
// coalescing indexes and RLS + FORCE on the three new tenant tables. Drop a predicate clause and CI
// stays green while a double-click spends two LLM generations; lose FORCE and the owner bypasses
// tenant isolation. Reads the LIVE catalog through the shared fixture.
import { describe, expect, test } from 'vitest';

import { createFixture } from './schema-ddl.fixture';

const __fixture = createFixture();

describe('generation coalescing indexes', () => {
  // Both cover queued AND processing, like jobs_runbook_coalesce_idx: a second generate command
  // while the first is mid-run is a duplicate, not new work.
  for (const [name, type] of [
    ['jobs_postmortem_coalesce_idx', 'postmortem.generate'],
    ['jobs_assessment_grade_coalesce_idx', 'assessment.grade'],
  ] as const) {
    test(`${name} is UNIQUE on (tenant_id, payload->>incidentId) WHERE type=${type} AND queued|processing`, () => {
      const def = __fixture.indexes.get(name);
      expect(def, `${name} is missing`).toBeDefined();
      const flat = __fixture.squash(def!);
      expect(flat).toContain('CREATEUNIQUEINDEX');
      expect(flat).toContain('USINGbtree(tenant_id,');
      expect(flat).toContain("payload->>'incidentId'");
      const where = flat.slice(flat.indexOf('WHERE'));
      expect(where).toContain(`type='${type}'`);
      expect(where).toContain("'queued'");
      expect(where).toContain("'processing'");
    });
  }
});

describe('postmortem tables under RLS', () => {
  for (const table of ['postmortems', 'postmortem_action_items', 'assessment_grades']) {
    test(`${table} has RLS enabled, FORCEd, and exactly one tenant_isolation policy`, () => {
      const row = __fixture.rlsTables.find((r) => r.table_name === table);
      expect(row, `${table} is missing`).toBeDefined();
      expect(row).toMatchObject({ rls_enabled: true, rls_forced: true, policy_count: 1 });
      const policy = __fixture.policies.find((p) => p.tablename === table);
      expect(policy?.policyname).toBe('tenant_isolation');
      expect(__fixture.squash(policy!.qual ?? '')).toContain(
        "tenant_id=(NULLIF(current_setting('app.tenant_id'::text,true),''::text))::uuid",
      );
    });
  }
});
