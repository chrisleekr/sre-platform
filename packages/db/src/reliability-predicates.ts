import { sql } from 'drizzle-orm';

// One definition of runbook adoption, shared by the reliability report and the RCA calibration read
// model so the two can never drift apart.
/**
 * Builds the SQL predicate for "this investigation run cited a search_runbooks evidence receipt".
 *
 * @param runsAlias - SQL alias of the investigation_runs row being tested; trusted source, never input.
 */
export function runbookCitedPredicate(runsAlias: string) {
  return sql.raw(`exists (
    select 1 from agent_tool_calls calls
    where calls.id = any(${runsAlias}.evidence_ids)
      and calls.tool = 'search_runbooks' and calls.outcome = 'data'
      and calls.output is not null
  )`);
}
