// The row ceiling on an evidence reload, which bounds how much is FETCHED rather than what the
// investigator sees. Split from tool-call-repo.test.ts, which is at its line cap. Runs as app_user
// so FORCE ROW LEVEL SECURITY binds, mirroring its sibling's harness.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { makeDb, createIncident, recordToolCall, type DbHandle } from '../index';
import { tenants, incidents, incidentMessages, agentToolCalls } from '../schema';
import * as toolCallRepo from '../tool-call-repo';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantId: string;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'evidence-cap' });
});

afterAll(async () => {
  if (admin) {
    // Child rows first: the tenant delete would otherwise fail the incidents foreign key and leave
    // this file's rows behind for every later run against the same database.
    await admin.db.delete(agentToolCalls).where(eq(agentToolCalls.tenantId, tenantId));
    await admin.db.delete(incidentMessages).where(eq(incidentMessages.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
});

/** Opens an incident owned by this file's tenant so each case pins an exact row count. */
async function newIncident(): Promise<string> {
  const incident = await createIncident(app.db, tenantId, {
    fingerprint: `fp-${randomUUID()}`,
    alertSource: 'datadog',
    service: 'checkout',
    severity: 'sev2',
  });
  return incident.id;
}

/** Records one tiny evidence row, spaced so createdAt ordering is unambiguous. */
async function record(incidentId: string, tool: string): Promise<void> {
  await recordToolCall(app.db, tenantId, {
    incidentId,
    tool,
    input: { n: tool },
    latencyMs: 1,
    outcome: 'data',
    output: { v: 1 },
  });
  await new Promise((r) => setTimeout(r, 3));
}

describe('loadIncidentEvidence row ceiling', () => {
  test('C1 truncates oldest-first and reports the full page', async () => {
    const incidentId = await newIncident();
    // Four distinct (tool, input) pairs, each tiny so the character budget never binds. Only the
    // ceiling can drop anything here, which is what makes the assertion discriminating.
    for (const tool of ['oldest', 'second', 'third', 'newest']) await record(incidentId, tool);

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(String(args[0]));
    let capped: toolCallRepo.IncidentEvidence[];
    try {
      capped = await toolCallRepo.loadIncidentEvidence(app.db, tenantId, incidentId, { limit: 2 });
    } finally {
      console.warn = realWarn;
    }

    // Newest-first fetch, so the ceiling sheds the OLDEST rows: the ones the newest-first budget
    // would shed anyway. Pinned as an exact array, because a ceiling that dropped the newest
    // instead would also return two rows.
    expect(capped.map((e) => e.tool)).toEqual(['newest', 'third']);
    // A full page is the only evidence that older rows existed and were never considered. Silent
    // truncation is indistinguishable from an incident that genuinely had two tool calls.
    expect(warnings.some((line) => line.includes('evidence_reload_truncated'))).toBe(true);
  });

  test('C2 an unusable ceiling falls back instead of fetching nothing', async () => {
    const incidentId = await newIncident();
    await record(incidentId, 'only_row');

    // Fail closed the way the budget does. Unlike the budget, an empty fetch is never something a
    // caller can mean by the ceiling, so 0 and a negative fall back rather than reloading nothing;
    // NaN and a fraction would otherwise reach the driver.
    for (const limit of [0, -1, Number.NaN, 1.5]) {
      const rows = await toolCallRepo.loadIncidentEvidence(app.db, tenantId, incidentId, { limit });
      expect(rows.map((e) => e.tool)).toEqual(['only_row']);
    }
  });

  test('C3 the default ceiling is not below what the default budget can pay for', () => {
    // Derived from the module's own constants, not restated: this fails if someone lowers the
    // default ceiling or raises the default budget past what the ceiling can feed. It does NOT
    // claim the ceiling is loss-free, because the two count different populations (raw rows here,
    // deduped lines there); it only pins that the coarse bound is not the obviously binding one.
    const budgetRows = Math.floor(
      toolCallRepo.EVIDENCE_BUDGET_CHARS / toolCallRepo.SHORTEST_EVIDENCE_BLOCK_CHARS,
    );
    expect(budgetRows).toBeLessThanOrEqual(toolCallRepo.DEFAULT_EVIDENCE_ROW_LIMIT);
  });

  test('C4 the truncation warn reports the budget row equivalent so the binding bound is visible', async () => {
    const incidentId = await newIncident();
    for (const tool of ['a', 'b', 'c']) await record(incidentId, tool);

    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(String(args[0]));
    let bare: string | undefined;
    try {
      // A caller-supplied measure, so `budget` is denominated in rendered-block characters and the
      // 83-char equivalence below is in the same unit. Any function works: the field is gated on
      // the caller having chosen a unit at all, not on which one.
      await toolCallRepo.loadIncidentEvidence(app.db, tenantId, incidentId, {
        limit: 2,
        measure: () => 100,
      });
      bare = warnings.at(-1);
      await toolCallRepo.loadIncidentEvidence(app.db, tenantId, incidentId, { limit: 2 });
    } finally {
      console.warn = realWarn;
    }

    expect(bare).toBeDefined();
    // Both numbers, not just the ceiling: the whole point of the field is that an operator can see
    // whether the row ceiling or the character budget decided the cut.
    const payload = JSON.parse(bare!) as {
      limit: number;
      budgetRows: number;
      pkg: string;
      distinctLines: number;
    };
    expect(payload.limit).toBe(2);
    // The collapse between the two populations: 2 raw rows here dedup to 2 distinct lines. Without
    // it a reader cannot tell a truncation that cost nothing from one that hid a tool result.
    expect(payload.distinctLines).toBe(2);
    expect(payload.budgetRows).toBe(
      Math.floor(toolCallRepo.EVIDENCE_BUDGET_CHARS / toolCallRepo.SHORTEST_EVIDENCE_BLOCK_CHARS),
    );
    expect(payload.pkg).toBe('@sre/db');

    // The default measure counts output JSON only, which is not the unit 83 is built from, so the
    // equivalence is OMITTED rather than reported in the wrong unit. Truncation is still reported.
    const defaulted = JSON.parse(warnings.at(-1)!) as Record<string, unknown>;
    expect(defaulted.event).toBe('evidence_reload_truncated');
    expect(defaulted).not.toHaveProperty('budgetRows');
  });
});
