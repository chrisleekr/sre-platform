// "working memory" — Phase A RED. Drives the evidence-store surface before it exists:
// agent_tool_calls.output (redacted tool output persisted in the SAME row as input) and
// loadIncidentEvidence (resume reload — latest-per-(tool, canonical input), createdAt-tagged,
// budget-bounded, RLS-scoped). Live-Postgres two-tenant harness mirrors composite-fk.test.ts /
// incident-repo-embedding.test.ts: admin (superuser) seeds/cleans the control-plane tenants; the
// repo runs as app_user so FORCE ROW LEVEL SECURITY binds.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { makeDb, createIncident, withTenant, recordToolCall, type DbHandle } from '../index';
import { tenants, incidents, incidentMessages, agentToolCalls } from '../schema';
// Namespace access so the not-yet-exported loadIncidentEvidence reads as `undefined` (per-assertion
// RED via a runtime TypeError) rather than an ESM link error that would abort the whole file.
import * as toolCallRepo from '../tool-call-repo';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;
let incidentA: string;
let incidentB: string;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'A' },
    { id: tenantB, name: 'B' },
  ]);
  incidentA = (
    await createIncident(app.db, tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
  incidentB = (
    await createIncident(app.db, tenantB, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(agentToolCalls).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(incidentMessages).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

// Read the full row back under the owning tenant's RLS context. `output` is not yet in the schema
// type, so widen the row to observe it — the assertion (not the type) proves the persist.
async function readCalls(tenant: string, incidentId: string) {
  const rows = await withTenant(app.db, tenant, (tx) =>
    tx.select().from(agentToolCalls).where(eq(agentToolCalls.incidentId, incidentId)),
  );
  return rows as Array<(typeof rows)[number] & { output?: unknown; createdAt: Date }>;
}

describe('recordToolCall persists a redacted output', () => {
  test('lists only bounded scrubbed summaries without raw request or output payloads', async () => {
    const id = await recordToolCall(app.db, tenantA, {
      incidentId: incidentA,
      tool: 'prometheus_query_range',
      input: { query: 'up{authorization="Bearer abcdef123456"}', password: 'do-not-project' },
      output: { marker: 'output-must-stay-in-detail' },
      latencyMs: 1,
      outcome: 'data',
    });
    const page = await toolCallRepo.listIncidentEvidencePage(app.db, tenantA, incidentA);
    const item = page.evidence.find((row) => row.id === id) as unknown as Record<string, unknown>;
    expect(item.summary).toEqual(expect.stringContaining('up{'));
    expect(JSON.stringify(item)).not.toContain('abcdef123456');
    expect(JSON.stringify(item)).not.toContain('do-not-project');
    expect(JSON.stringify(item)).not.toContain('output-must-stay-in-detail');
    expect(item).not.toHaveProperty('input');
    expect(item).not.toHaveProperty('output');
    expect(
      (await toolCallRepo.listIncidentEvidencePage(app.db, tenantB, incidentA)).evidence,
    ).toEqual([]);
  });
  test('C1 stores output in the SAME row as input, readable back under the owning tenant (RLS)', async () => {
    // The caller redacts before persist; a `token` key must never reach the store.
    const redactedOutput = { deploys: [{ changeId: 'deploy-marker-1', token: '[REDACTED]' }] };
    const id = await recordToolCall(app.db, tenantA, {
      incidentId: incidentA,
      tool: 'datadog_query_metrics',
      input: { service: 'checkout', windowMinutes: 30 },
      latencyMs: 3,
      outcome: 'data',
      // RED: NewToolCall has no `output` field yet, and there is no `output` column, so this value
      // is dropped and reads back as undefined.
      output: redactedOutput,
    } as Parameters<typeof recordToolCall>[2] & { output: unknown });

    const rows = await readCalls(tenantA, incidentA);
    const row = rows.find((r) => r.id === id)!;
    expect(row).toBeDefined();
    // Same row carries both input and the redacted output.
    expect(row.input).toEqual({ service: 'checkout', windowMinutes: 30 });
    expect(row.output).toEqual(redactedOutput);
  });
});

describe('loadIncidentEvidence resume reload', () => {
  const BUDGET = 24_000;

  test('C4 returns the latest row per (tool, canonicalized input), createdAt-tagged', async () => {
    const inputAlpha = { service: 'checkout', windowMinutes: 30 };
    // Two runs of the SAME tool+input: the newer output must win (collapse repeated fetches).
    await recordToolCall(app.db, tenantA, {
      incidentId: incidentA,
      tool: 'datadog_search',
      input: inputAlpha,
      latencyMs: 1,
      outcome: 'data',
      output: { lines: ['old'] },
    } as Parameters<typeof recordToolCall>[2] & { output: unknown });
    await new Promise((r) => setTimeout(r, 5));
    await recordToolCall(app.db, tenantA, {
      incidentId: incidentA,
      tool: 'datadog_search',
      input: inputAlpha,
      latencyMs: 1,
      outcome: 'data',
      output: { lines: ['new'] },
    } as Parameters<typeof recordToolCall>[2] & { output: unknown });
    // The SAME logical input with REORDERED keys must collapse onto inputAlpha (exercises
    // canonicalize's sorted-key path — plain JSON.stringify would treat this as a distinct line).
    await new Promise((r) => setTimeout(r, 5));
    await recordToolCall(app.db, tenantA, {
      incidentId: incidentA,
      tool: 'datadog_search',
      input: { windowMinutes: 30, service: 'checkout' },
      latencyMs: 1,
      outcome: 'data',
      output: { lines: ['reordered-newest'] },
    } as Parameters<typeof recordToolCall>[2] & { output: unknown });
    // A DISTINCT input for the same tool is a separate evidence line, kept.
    await recordToolCall(app.db, tenantA, {
      incidentId: incidentA,
      tool: 'datadog_search',
      input: { service: 'checkout', windowMinutes: 60 },
      latencyMs: 1,
      outcome: 'data',
      output: { lines: ['wide'] },
    } as Parameters<typeof recordToolCall>[2] & { output: unknown });

    // RED: loadIncidentEvidence is not exported yet → undefined → TypeError at the call.
    const evidence = await toolCallRepo.loadIncidentEvidence(app.db, tenantA, incidentA, {
      budget: BUDGET,
    });

    const logsEntries = evidence.filter((e) => e.tool === 'datadog_search');
    // Three writes to the (datadog_search, service+30) key — one with reordered keys — collapse to one;
    // the distinct-window fetch survives → 2 lines.
    expect(logsEntries).toHaveLength(2);
    const win30 = logsEntries.find(
      (e) => (e.input as { windowMinutes?: number }).windowMinutes === 30,
    )!;
    // Newest per (tool, canonical input): the reordered-key write is the latest and wins, proving
    // key-order-insensitive collapse.
    expect(win30.output).toEqual({ lines: ['reordered-newest'] });
    expect(win30.createdAt).toBeInstanceOf(Date); // tagged for staleness judgment
  });

  test('C4 keeps the NEWEST lines that fit and drops the oldest past the budget', async () => {
    // Three distinct fat outputs (~311 chars each), written oldest→newest. A budget of 650 fits
    // exactly two, so the two newest survive and the oldest is dropped.
    for (let i = 0; i < 3; i++) {
      await recordToolCall(app.db, tenantA, {
        incidentId: incidentA,
        tool: `fat_tool_${i}`,
        input: { service: 'checkout', windowMinutes: i },
        latencyMs: 1,
        outcome: 'data',
        output: { blob: 'x'.repeat(300) }, // JSON.stringify → 311 chars
      } as Parameters<typeof recordToolCall>[2] & { output: unknown });
      await new Promise((r) => setTimeout(r, 3));
    }

    const evidence = await toolCallRepo.loadIncidentEvidence(app.db, tenantA, incidentA, {
      budget: 650,
    });
    const total = evidence.reduce((n, e) => n + JSON.stringify(e.output).length, 0);
    expect(total).toBeLessThanOrEqual(650);
    const kept = evidence.filter((e) => e.tool.startsWith('fat_tool_')).map((e) => e.tool);
    expect(kept.sort()).toEqual(['fat_tool_1', 'fat_tool_2']); // two NEWEST kept
    expect(kept).not.toContain('fat_tool_0'); // oldest dropped
  });

  test('C4 a single over-budget NEWEST output does not evict the smaller older lines', async () => {
    // The point of the greedy skip (not break): a fat newest line must not blank the whole reload.
    await recordToolCall(app.db, tenantA, {
      incidentId: incidentA,
      tool: 'small_old_a',
      input: { n: 1 },
      latencyMs: 1,
      outcome: 'data',
      output: { v: 'a' },
    } as Parameters<typeof recordToolCall>[2] & { output: unknown });
    await new Promise((r) => setTimeout(r, 3));
    await recordToolCall(app.db, tenantA, {
      incidentId: incidentA,
      tool: 'small_old_b',
      input: { n: 2 },
      latencyMs: 1,
      outcome: 'data',
      output: { v: 'b' },
    } as Parameters<typeof recordToolCall>[2] & { output: unknown });
    await new Promise((r) => setTimeout(r, 3));
    // Newest, and alone larger than the whole budget.
    await recordToolCall(app.db, tenantA, {
      incidentId: incidentA,
      tool: 'fat_new',
      input: { n: 3 },
      latencyMs: 1,
      outcome: 'data',
      output: { blob: 'x'.repeat(500) },
    } as Parameters<typeof recordToolCall>[2] & { output: unknown });

    const evidence = await toolCallRepo.loadIncidentEvidence(app.db, tenantA, incidentA, {
      budget: 200,
    });
    const tools = evidence.map((e) => e.tool);
    // The oversized newest line is skipped, but the two smaller older lines survive (a `break` here
    // would have returned nothing because the oversized line sorts first).
    expect(tools).not.toContain('fat_new');
    expect(tools).toContain('small_old_a');
    expect(tools).toContain('small_old_b');
  });

  test('C1 measures each candidate with the supplied measure function', async () => {
    // The budget must be spent in the unit the prompt actually renders. renderEvidence emits a JSON
    // header line plus a TOON payload, which measures larger than compact JSON, so the caller has to
    // be able to supply its own sizing function instead of inheriting JSON.stringify.
    await new Promise((r) => setTimeout(r, 5));
    await recordToolCall(app.db, tenantA, {
      incidentId: incidentA,
      tool: 'measured_newest',
      input: { n: 42 },
      latencyMs: 1,
      outcome: 'data',
      output: { blob: 'x'.repeat(100) }, // JSON.stringify -> 111 chars
    } as Parameters<typeof recordToolCall>[2] & { output: unknown });

    const BUDGET_CHARS = 200;

    // Control: it is the newest line, so it is weighed first against an empty budget, and 111 fits.
    const withDefault = await toolCallRepo.loadIncidentEvidence(app.db, tenantA, incidentA, {
      budget: BUDGET_CHARS,
    });
    expect(withDefault.map((e) => e.tool)).toContain('measured_newest');

    // The supplied measure triples the size: 111 * 3 = 333 overruns the 200-char budget, so the
    // line the default measure kept above is now skipped. The control assertion is what makes this
    // discriminating: the same row, same budget, differing only by the measure.
    const withMeasure = await toolCallRepo.loadIncidentEvidence(app.db, tenantA, incidentA, {
      budget: BUDGET_CHARS,
      measure: (line: toolCallRepo.IncidentEvidence) => JSON.stringify(line.output).length * 3,
    });
    expect(withMeasure.map((e) => e.tool)).not.toContain('measured_newest');
  });

  test('C2 omitting measure falls back to the compact-JSON output length', async () => {
    // Own incident, own rows: pinning an exact array over the corpus the earlier tests accumulate
    // would make this fail in isolation and would silently re-target on any row added above it.
    const incidentC = (
      await createIncident(app.db, tenantA, {
        fingerprint: `fp-${randomUUID()}`,
        alertSource: 'datadog',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;

    // Written oldest first; compact-JSON output lengths in comments.
    const rows = [
      ['old_small', { v: 'a' }], // {"v":"a"} = 9
      ['fat', { blob: 'x'.repeat(500) }], // 511
      ['newest', { blob: 'x'.repeat(100) }], // 111
    ] as const;
    for (const [tool, output] of rows) {
      await recordToolCall(app.db, tenantA, {
        incidentId: incidentC,
        tool,
        input: { n: tool },
        latencyMs: 1,
        outcome: 'data',
        output,
      } as Parameters<typeof recordToolCall>[2] & { output: unknown });
      await new Promise((r) => setTimeout(r, 3));
    }

    const BUDGET_CHARS = 650;
    const withoutMeasure = await toolCallRepo.loadIncidentEvidence(app.db, tenantA, incidentC, {
      budget: BUDGET_CHARS,
    });
    // Newest-first, so 111 + 511 + 9 = 631 of 650 and all three fit. The pin is absolute, not just
    // a comparison against the explicit copy below: two selections agreeing would still pass for a
    // default that is close but wrong.
    expect(withoutMeasure.map((e) => e.tool)).toEqual(['newest', 'fat', 'old_small']);

    const withExplicitDefault = await toolCallRepo.loadIncidentEvidence(
      app.db,
      tenantA,
      incidentC,
      {
        budget: BUDGET_CHARS,
        measure: (line: toolCallRepo.IncidentEvidence) => JSON.stringify(line.output).length,
      },
    );
    expect(withoutMeasure.map((e) => e.tool)).toEqual(withExplicitDefault.map((e) => e.tool));
  });

  test('C4 an explicit budget of 0 reloads nothing, it does not fall back to the default', async () => {
    // The non-finite budget guard must not swallow a legitimate 0. Coercing it to the 24k default
    // would hand back a full reload to a caller that asked for none. Own incident and own row, so
    // the assertion cannot pass merely because no evidence exists.
    const incidentE = (
      await createIncident(app.db, tenantA, {
        fingerprint: `fp-${randomUUID()}`,
        alertSource: 'datadog',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    await recordToolCall(app.db, tenantA, {
      incidentId: incidentE,
      tool: 'present',
      input: { n: 1 },
      latencyMs: 1,
      outcome: 'data',
      output: { v: 'a' },
    } as Parameters<typeof recordToolCall>[2] & { output: unknown });

    // Control: the row is genuinely loadable, so the assertion below is about the budget alone.
    expect(
      (await toolCallRepo.loadIncidentEvidence(app.db, tenantA, incidentE)).map((e) => e.tool),
    ).toEqual(['present']);

    expect(
      await toolCallRepo.loadIncidentEvidence(app.db, tenantA, incidentE, { budget: 0 }),
    ).toEqual([]);
  });

  test('C3 an unusable measure drops its own line, it does not disable the cap', async () => {
    // The guard's whole point: `used + NaN > budget` is false, so an unguarded NaN would keep every
    // line thereafter and unbound the prompt. A throwing measure must be contained the same way,
    // rather than rejecting the reload and costing the caller ALL of its evidence.
    const incidentD = (
      await createIncident(app.db, tenantA, {
        fingerprint: `fp-${randomUUID()}`,
        alertSource: 'datadog',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    for (const tool of ['broken', 'healthy'] as const) {
      await recordToolCall(app.db, tenantA, {
        incidentId: incidentD,
        tool,
        input: { n: tool },
        latencyMs: 1,
        outcome: 'data',
        output: { v: tool },
      } as Parameters<typeof recordToolCall>[2] & { output: unknown });
      await new Promise((r) => setTimeout(r, 3));
    }

    for (const [label, broken] of [
      ['NaN', () => Number.NaN],
      ['negative', () => -1_000_000],
      [
        'throw',
        () => {
          throw new Error('unmeasurable');
        },
      ],
    ] as const) {
      const kept = await toolCallRepo.loadIncidentEvidence(app.db, tenantA, incidentD, {
        budget: 24_000,
        measure: (line: toolCallRepo.IncidentEvidence) =>
          line.tool === 'broken' ? broken() : JSON.stringify(line.output).length,
      });
      expect(
        kept.map((e) => e.tool),
        label,
      ).toEqual(['healthy']);
    }
  });

  test('C5 is tenant-scoped: tenant B never loads tenant A evidence, and vice versa (RLS)', async () => {
    await recordToolCall(app.db, tenantB, {
      incidentId: incidentB,
      tool: 'datadog_query_metrics',
      input: { service: 'checkout', windowMinutes: 30 },
      latencyMs: 1,
      outcome: 'data',
      output: { onlyB: true },
    } as Parameters<typeof recordToolCall>[2] & { output: unknown });

    const asB = await toolCallRepo.loadIncidentEvidence(app.db, tenantB, incidentB, {
      budget: BUDGET,
    });
    // B sees its own row and never any of A's incident rows.
    expect(asB.every((e) => JSON.stringify(e.output).indexOf('deploy-marker-1') === -1)).toBe(true);
    expect(asB.some((e) => (e.output as { onlyB?: boolean }).onlyB === true)).toBe(true);

    // Reading A's incident under tenant B's context returns nothing (RLS blocks the cross-tenant read).
    const bReadsA = await toolCallRepo.loadIncidentEvidence(app.db, tenantB, incidentA, {
      budget: BUDGET,
    });
    expect(bReadsA).toHaveLength(0);
  });
});

describe('human evidence ledger', () => {
  test('paginates every audited run and lazy-loads redacted detail under RLS', async () => {
    const incidentId = (
      await createIncident(app.db, tenantA, {
        fingerprint: randomUUID(),
        alertSource: 'slack',
        service: 'ledger',
        severity: 'sev3',
      })
    ).id;
    for (let i = 0; i < 3; i++) {
      await recordToolCall(app.db, tenantA, {
        incidentId,
        tool: `check_${i}`,
        input: { token: '[REDACTED]', index: i },
        latencyMs: i + 1,
        outcome: i === 2 ? 'error' : 'data',
        output: { value: i },
      });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const first = await toolCallRepo.listIncidentEvidencePage(app.db, tenantA, incidentId, {
      limit: 2,
    });
    expect(first.evidence).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await toolCallRepo.listIncidentEvidencePage(app.db, tenantA, incidentId, {
      limit: 2,
      before: first.nextCursor!,
    });
    expect(second.evidence).toHaveLength(1);
    expect(new Set([...first.evidence, ...second.evidence].map((item) => item.id)).size).toBe(3);

    const detail = await toolCallRepo.getIncidentEvidence(
      app.db,
      tenantA,
      incidentId,
      first.evidence[0]!.id,
    );
    expect(detail?.input).toMatchObject({ token: '[REDACTED]' });
    expect(
      await toolCallRepo.getIncidentEvidence(app.db, tenantB, incidentId, first.evidence[0]!.id),
    ).toBeNull();
    expect(
      await toolCallRepo.getIncidentEvidenceProgress(app.db, tenantA, incidentId),
    ).toMatchObject({
      total: 3,
      successful: 2,
      failed: 1,
    });
  });

  test('searches prior redacted evidence within the owning incident and returns compact projections', async () => {
    const incidentId = (
      await createIncident(app.db, tenantA, {
        fingerprint: randomUUID(),
        alertSource: 'slack',
        service: 'database',
        severity: 'sev3',
      })
    ).id;
    const evidenceId = await recordToolCall(app.db, tenantA, {
      incidentId,
      tool: 'prometheus_query',
      input: { query: 'database_storage_size_bytes' },
      latencyMs: 2,
      outcome: 'data',
      output: { data: { resultType: 'vector', result: [{ value: [1, '206393344'] }] } },
    });

    const matches = await toolCallRepo.searchIncidentEvidence(
      app.db,
      tenantA,
      incidentId,
      'storage_size',
    );
    expect(matches).toEqual([
      expect.objectContaining({
        evidenceId,
        tool: 'prometheus_query',
        input: { query: 'database_storage_size_bytes' },
        outcome: 'data',
        projection: expect.objectContaining({ kind: 'facts' }),
      }),
    ]);
    expect(
      await toolCallRepo.searchIncidentEvidence(
        app.db,
        tenantA,
        incidentId,
        'disk storage_size missing-node',
      ),
    ).toEqual(matches);
    expect(await toolCallRepo.searchIncidentEvidence(app.db, tenantA, incidentId, '%')).toEqual([]);
    expect(
      await toolCallRepo.searchIncidentEvidence(app.db, tenantB, incidentId, 'storage_size'),
    ).toEqual([]);
  });
});

describe('hasToolCall idempotency probe', () => {
  test('true once a row exists for (incident, tool), false for a tool never run', async () => {
    expect(await toolCallRepo.hasToolCall(app.db, tenantA, incidentA, 'probe_tool')).toBe(false);

    await recordToolCall(app.db, tenantA, {
      incidentId: incidentA,
      tool: 'probe_tool',
      input: { service: 'checkout' },
      latencyMs: 1,
      outcome: 'data',
      output: { ok: true },
    } as Parameters<typeof recordToolCall>[2] & { output: unknown });

    expect(await toolCallRepo.hasToolCall(app.db, tenantA, incidentA, 'probe_tool')).toBe(true);
    // Scoped to the tool, not "any evidence for the incident".
    expect(await toolCallRepo.hasToolCall(app.db, tenantA, incidentA, 'never_run_tool')).toBe(
      false,
    );
  });

  test('tenant-scoped: another tenant never sees the row (RLS)', async () => {
    await recordToolCall(app.db, tenantB, {
      incidentId: incidentB,
      tool: 'tenant_scoped_probe',
      input: { service: 'checkout' },
      latencyMs: 1,
      outcome: 'data',
      output: { ok: true },
    } as Parameters<typeof recordToolCall>[2] & { output: unknown });

    expect(await toolCallRepo.hasToolCall(app.db, tenantB, incidentB, 'tenant_scoped_probe')).toBe(
      true,
    );
    // A's context must not observe B's row — a true here would leak a cross-tenant existence oracle.
    expect(await toolCallRepo.hasToolCall(app.db, tenantA, incidentB, 'tenant_scoped_probe')).toBe(
      false,
    );
  });
});
