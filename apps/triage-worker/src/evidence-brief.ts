import { redactInput, type ToolContext } from '@sre/agent-tools';

// The connectors (GitLab, k8s) are separate services, unaffected by an LLM-provider outage, so a
// degraded brief can still carry real signal. Bounds mirror the loop's per-result cap.
const BRIEF_WINDOW_MINUTES = 60;
const BRIEF_ITEM_MAX = 1200;
const NO_DATA = 'No live connector data available.';

/**
 * Assemble an evidence brief by pulling each resolved connector's triage context directly, without
 * the LLM. The engine's tools are per-connector, so the brief runs no tool definitions; it calls `fetchTriageContext` on the tenant's connectors (the same first-pass
 * pull the opener seed uses). Runs them concurrently; a connector that throws (e.g. an alert-only
 * stub whose `fetchTriageContext` is unimplemented) is skipped, never rejecting the brief (CWE-209).
 * Returns a marker when nothing is live.
 *
 * The connector `data` is redacted here, before it reaches the durable finding, the hub, and Slack.
 * The degrade path does NOT pass through the onStep scrub choke point (`degradeIncidentWithMessages`
 * inserts finding content verbatim), so this is the redaction point. It matches `seedFirstPass`, which
 * redacts the same `fetchTriageContext` output before Postgres (CWE-532). The brief used to inherit
 * the identical redaction via `runTool`, which it no longer calls.
 */
export async function buildEvidenceBrief(
  ctx: ToolContext,
  service: string,
  windowMinutes: number = BRIEF_WINDOW_MINUTES,
): Promise<string> {
  let connectors: Awaited<ReturnType<ToolContext['resolveConnectors']>>;
  try {
    connectors = await ctx.resolveConnectors();
  } catch {
    return NO_DATA;
  }
  // Gather concurrently but keep connector-resolution order deterministic: map to a positional
  // slot, then drop the empties. Pushing from the callbacks would order by completion, not input.
  const sections = (
    await Promise.all(
      connectors.map(async (c) => {
        try {
          const tc = await c.fetchTriageContext({ service, windowMinutes });
          const json = JSON.stringify(redactInput(tc.data)) ?? 'null';
          return `- ${c.type}: ${json.slice(0, BRIEF_ITEM_MAX)}`;
        } catch {
          // Alert-only / unavailable connector: skip it, never reject the whole brief (CWE-209).
          return null;
        }
      }),
    )
  ).filter((s): s is string => s !== null);
  return sections.length > 0 ? sections.join('\n') : NO_DATA;
}
