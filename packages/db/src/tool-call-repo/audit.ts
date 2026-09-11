import { and, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm';
import type { Db } from '../client';
import type { Tx } from '../rls';
import { withTenant } from '../rls';
import { agentToolCalls } from '../schema';

export interface NewToolCall {
  incidentId: string;
  tool: string;
  /** The tool input AFTER redaction; the caller scrubs sensitive values (CWE-532). */
  input: unknown;
  latencyMs: number;
  outcome: string;
  /** The tool output AFTER redaction (working-memory evidence). Omitted for non-data runs. */
  output?: unknown;
}

/**
 * Persist one tool-run audit row under the tenant's RLS context; returns the new row id.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param call - Audited tool call to persist.
 */
export async function recordToolCall(db: Db, tenantId: string, call: NewToolCall): Promise<string> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .insert(agentToolCalls)
      // Trusted tenantId last: the invariant must not depend on object key order (a field on
      // `call` can never override the session tenant). Backstopped by the RLS WITH CHECK policy.
      .values({ ...call, tenantId })
      .returning({ id: agentToolCalls.id });
    return rows[0]!.id;
  });
}

function normalizedEvidenceIds(proposed: string[]): string[] {
  return [...new Set(proposed)]
    .filter((id) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
    )
    .slice(0, 500);
}

/**
 * Keep only durable ids from this incident in their proposed order. Tenant scope comes from RLS.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param incidentId - Incident targeted by the operation.
 * @param proposed - Candidate evidence identifiers to validate.
 */
export async function filterIncidentEvidenceIdsTx(
  tx: Tx,
  incidentId: string,
  proposed: string[],
): Promise<string[]> {
  const unique = normalizedEvidenceIds(proposed);
  if (unique.length === 0) return [];
  const rows = await tx
    .select({ id: agentToolCalls.id })
    .from(agentToolCalls)
    .where(and(eq(agentToolCalls.incidentId, incidentId), inArray(agentToolCalls.id, unique)));
  const allowed = new Set(rows.map((row) => row.id));
  return unique.filter((id) => allowed.has(id));
}

/**
 * Keep only successful data-producing evidence from this incident.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param incidentId - Incident targeted by the operation.
 * @param proposed - Candidate factual evidence identifiers to validate.
 */
export async function filterIncidentDataEvidenceIdsTx(
  tx: Tx,
  incidentId: string,
  proposed: string[],
): Promise<string[]> {
  const unique = normalizedEvidenceIds(proposed);
  if (unique.length === 0) return [];
  const rows = await tx
    .select({ id: agentToolCalls.id })
    .from(agentToolCalls)
    .where(
      and(
        eq(agentToolCalls.incidentId, incidentId),
        inArray(agentToolCalls.id, unique),
        eq(agentToolCalls.outcome, 'data'),
        isNotNull(agentToolCalls.output),
      ),
    );
  const allowed = new Set(rows.map((row) => row.id));
  return unique.filter((id) => allowed.has(id));
}

/**
 * Tenant-scoped wrapper for tools that need to preserve only real incident evidence links.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 * @param proposed - Candidate evidence identifiers to validate.
 */
export async function filterIncidentEvidenceIds(
  db: Db,
  tenantId: string,
  incidentId: string,
  proposed: string[],
): Promise<string[]> {
  return withTenant(db, tenantId, (tx) => filterIncidentEvidenceIdsTx(tx, incidentId, proposed));
}

/**
 * Recovery requires successful evidence recorded during the current verification attempt.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param incidentId - Incident targeted by the operation.
 * @param proposed - Candidate evidence identifiers to validate.
 * @param verificationStartedAt - Time boundary used by the operation.
 */
export async function filterRecoveryEvidenceIdsTx(
  tx: Tx,
  incidentId: string,
  proposed: string[],
  verificationStartedAt: Date,
): Promise<string[]> {
  const unique = normalizedEvidenceIds(proposed);
  if (unique.length === 0) return [];
  const rows = await tx
    .select({ id: agentToolCalls.id })
    .from(agentToolCalls)
    .where(
      and(
        eq(agentToolCalls.incidentId, incidentId),
        inArray(agentToolCalls.id, unique),
        eq(agentToolCalls.outcome, 'data'),
        isNotNull(agentToolCalls.output),
        gte(agentToolCalls.createdAt, verificationStartedAt),
      ),
    );
  const allowed = new Set(rows.map((row) => row.id));
  return unique.filter((id) => allowed.has(id));
}

/**
 * Checks whether tool call.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 * @param tool - Value supplied for tool.
 * @param since - Lower time boundary for matching records.
 */
export async function hasToolCall(
  db: Db,
  tenantId: string,
  incidentId: string,
  tool: string,
  since?: Date,
): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: agentToolCalls.id })
      .from(agentToolCalls)
      .where(
        and(
          eq(agentToolCalls.incidentId, incidentId),
          eq(agentToolCalls.tool, tool),
          since ? gte(agentToolCalls.createdAt, since) : undefined,
        ),
      )
      .limit(1);
    return rows.length > 0;
  });
}

/**
 * Provides latest tool call.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 * @param tool - Value supplied for tool.
 * @param since - Lower time boundary for matching records.
 */
export async function latestToolCall(
  db: Db,
  tenantId: string,
  incidentId: string,
  tool: string,
  since?: Date,
): Promise<IncidentEvidence | null> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: agentToolCalls.id,
        tool: agentToolCalls.tool,
        input: agentToolCalls.input,
        output: agentToolCalls.output,
        createdAt: agentToolCalls.createdAt,
      })
      .from(agentToolCalls)
      .where(
        and(
          eq(agentToolCalls.incidentId, incidentId),
          eq(agentToolCalls.tool, tool),
          isNotNull(agentToolCalls.output),
          since ? gte(agentToolCalls.createdAt, since) : undefined,
        ),
      )
      .orderBy(desc(agentToolCalls.createdAt))
      .limit(1);
    return rows[0] ?? null;
  });
}

/** One reloaded evidence line: a past tool run's redacted output, tagged for staleness judgment. */
export interface IncidentEvidence {
  id: string;
  tool: string;
  input: unknown;
  output: unknown;
  createdAt: Date;
}

export interface LoadEvidenceOptions {
  /** Budget in whatever unit `measure` returns; newest-first, any line that would overflow is skipped. */
  budget?: number;
  /**
   * Sizes one candidate line against the budget. Supply the caller's own renderer so the budget is
   * spent in the unit the prompt actually costs; defaults to the compact JSON length of the output.
   */
  measure?: (line: IncidentEvidence) => number;
  /** Newest-first ceiling on rows fetched, before dedup. Bounds memory, not what the model sees. */
  limit?: number;
}

/** Default char budget for reloaded evidence. ~24k keeps resume prompts bounded. */
export const DEFAULT_EVIDENCE_BUDGET_CHARS = 24000;
/**
 * Bootstrap char budget for reloaded evidence, read from the environment.
 *
 * The durable `EVIDENCE_BUDGET_CHARS` platform setting is the operator-facing control and overrides
 * this; the env value only decides the budget before a setting is readable. Guarded like its
 * siblings (toolResultMaxChars, triageContextWindowMin): a non-numeric or non-positive env would
 * yield NaN and silently disable the cap (`used + size > NaN` is always false), unbounding the
 * resume prompt.
 */
export const EVIDENCE_BUDGET_CHARS = ((): number => {
  const n = Number(process.env.EVIDENCE_BUDGET_CHARS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EVIDENCE_BUDGET_CHARS;
})();

/**
 * Shortest rendered evidence block, in the characters the budget is spent in.
 *
 * The header alone is 80 at its smallest: the reference, a uuid, a one-letter tool, an empty JSON
 * input and an ISO timestamp. A newline and a one-character payload make the block 82, and the
 * separator the measure also charges brings it to 84. It is 83 rather than 84 because an empty
 * object encodes to an empty document, contributing no payload characters at all, and an empty
 * object is a storable tool output: the reload filters on SQL NOT NULL, which a jsonb `{}` passes.
 *
 * Pinned by a test beside the renderer that ranges over every payload shape reaching it, so this is
 * a measured floor rather than one sampled shape.
 */
export const SHORTEST_EVIDENCE_BLOCK_CHARS = 83;

/**
 * Ceiling on rows fetched by one evidence reload, applied newest-first before dedup.
 *
 * This is a memory bound. It exists so an incident with thousands of tool calls cannot pull an
 * unbounded result set into a worker; deciding what the investigator actually sees is the character
 * budget's job, and the budget runs after this.
 *
 * The two bounds count different populations and cannot be compared directly: this counts RAW rows
 * before dedup, while the budget counts distinct (tool, input) lines after it. So a ceiling numerically
 * above the budget's maximum line count still guarantees nothing. A distinct pair whose newest run
 * sits past the ceiling is dropped even when the budget had room, and repeats are the normal case
 * here, which is why the dedup exists at all. Hitting the ceiling is therefore reported rather than
 * silent, and the report carries the budget's row equivalent so an operator can see which bound bit.
 */
export const DEFAULT_EVIDENCE_ROW_LIMIT = 1000;

// Stable-key canonicalization of a tool input so two runs of the same (tool, input) collapse to one
// evidence line regardless of JSON key order. Recurses objects with sorted keys; arrays/scalars
// serialize as-is.
function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return v;
  });
}

/**
 * Loads incident evidence.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 * @param opts - Optional query or behavior controls.
 */
export async function loadIncidentEvidence(
  db: Db,
  tenantId: string,
  incidentId: string,
  opts: LoadEvidenceOptions = {},
): Promise<IncidentEvidence[]> {
  // A caller-supplied budget gets the same treatment the env-derived default already gets above.
  // The Infinity sentinel below only skips while the budget is finite: at Infinity the comparison
  // `used + Infinity > Infinity` is false, and at NaN every comparison is false, either of which
  // would keep the unmeasurable line and unbound the prompt.
  const requested = opts.budget ?? EVIDENCE_BUDGET_CHARS;
  // `>= 0`, not `> 0`: unlike the env default above, an explicit 0 from a caller is a real
  // instruction to reload nothing, and coercing it to 24k would fail open on the caller's intent.
  const budget = Number.isFinite(requested) && requested >= 0 ? requested : EVIDENCE_BUDGET_CHARS;

  const rawMeasure =
    opts.measure ?? ((line: IncidentEvidence) => JSON.stringify(line.output).length);
  // Fail closed: an unusable size must drop its own line, never disable the cap for every line. The
  // measure is caller-supplied, so it is the untrusted input here. A throw is contained for the same
  // reason: uncaught, it would reject the whole reload and the callers' catch would drop ALL
  // evidence, not the one line that could not be sized. A negative size would decrement `used` and
  // unbound the loop, so it is refused too.
  const measure = (line: IncidentEvidence): number => {
    let size: number;
    try {
      size = rawMeasure(line);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
    return Number.isFinite(size) && size >= 0 ? size : Number.POSITIVE_INFINITY;
  };

  const requestedLimit = opts.limit ?? DEFAULT_EVIDENCE_ROW_LIMIT;
  // Same fail-closed treatment the budget gets: a non-integer or non-positive limit would either
  // throw in the driver or fetch nothing, so an unusable value falls back to the default ceiling
  // rather than silently changing how much evidence an incident can reload.
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit > 0
      ? requestedLimit
      : DEFAULT_EVIDENCE_ROW_LIMIT;

  // Only the fetch runs under the tenant transaction. The dedup and budget passes below are pure
  // functions of already-fetched, already-tenant-scoped rows, and the budget pass calls a
  // caller-supplied `measure` that encodes every candidate. Running that inside `withTenant` held
  // one of five pooled connections open for the duration of CPU-bound work on a single-threaded
  // worker; RLS scoping is unaffected because `measure` runs after row selection and cannot
  // influence it.
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        id: agentToolCalls.id,
        tool: agentToolCalls.tool,
        input: agentToolCalls.input,
        output: agentToolCalls.output,
        createdAt: agentToolCalls.createdAt,
      })
      .from(agentToolCalls)
      .where(and(eq(agentToolCalls.incidentId, incidentId), isNotNull(agentToolCalls.output)))
      // id breaks the tie: created_at is millisecond precision, so rows CAN share a timestamp, and
      // without a tiebreaker which row falls either side of the cut is arbitrary and can differ
      // between two reloads of the same incident. Matches the (incident_id, created_at DESC,
      // id DESC) index, so the ordering is still index-supplied.
      .orderBy(desc(agentToolCalls.createdAt), desc(agentToolCalls.id))
      .limit(limit),
  );

  // Collapse to the newest row per (tool, canonical input): rows are already newest-first, so the
  // first occurrence of a key wins.
  const seen = new Set<string>();
  const latest: IncidentEvidence[] = [];
  for (const row of rows) {
    const key = `${row.tool}\x00${canonicalize(row.input)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push({
      id: row.id,
      tool: row.tool,
      input: row.input,
      output: row.output,
      createdAt: row.createdAt,
    });
  }

  // A full page is the only signal available without a second counting query, so this says MAY have
  // been truncated: an incident holding exactly `limit` rows reports here having lost nothing. It is
  // still reported rather than swallowed, because a drop path that records nothing cannot be told
  // apart from an incident that genuinely had this many tool calls. Emitted after the dedup pass on
  // purpose: `limit` counts raw rows while `budgetRows`, when the caller sizes in rendered-block
  // characters, counts the lines the budget could pay for. Those are different populations, and
  // `distinctLines` is the collapse between them. Without it an operator cannot tell a truncation
  // that cost nothing from one that hid a tool result.
  if (rows.length === limit) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        pkg: '@sre/db',
        event: 'evidence_reload_truncated',
        msg: 'evidence reload returned a full page; older rows may not have been considered',
        tenantId,
        incidentId,
        limit,
        distinctLines: latest.length,
        // Only when the caller sized in rendered-block characters. The default measure counts
        // output JSON alone, which excludes the header, newline and separator that 83 is built
        // from, so the equivalence would be a different unit and would understate the payable
        // line count rather than admit it could not be computed.
        ...(opts.measure ? { budgetRows: Math.floor(budget / SHORTEST_EVIDENCE_BLOCK_CHARS) } : {}),
      }),
    );
  }

  // Budget-bound newest-first: greedily keep every line that fits, SKIPPING (not stopping at) one
  // that would overflow, so a single fat newest output cannot evict all the smaller older lines
  // behind it (the point of the budget is to shed the oldest, never to blank the whole reload).
  const kept: IncidentEvidence[] = [];
  let used = 0;
  for (const line of latest) {
    const size = measure(line);
    if (used + size > budget) continue;
    kept.push(line);
    used += size;
  }
  return kept;
}
