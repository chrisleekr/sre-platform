# Triage engine

Choose which model investigates your incidents, cap what it may spend, and see what it cost.

For what the engine actually does with an incident, see
[How triage works](../understand/triage.md).

## One provider per deployment

The platform runs exactly one model provider. You pick Claude or OpenAI; there is no automatic
failover to the other. If the provider is unreachable the platform says so and retries, rather than
quietly answering from a different model with different behaviour.

Changing the provider or model takes effect on the next investigation. You do not need to restart
anything. An investigation already in flight finishes on the settings it started with.

## Where it is configured

Everything the engine runs on is installation-wide and is set under **Platform administration** →
**Platform settings**, which only a platform administrator can open. A workspace's own Settings page
covers the workspace name, sign-in methods, and members; it does not touch the engine.

The **Investigator model** card sets the runtime (Claude Agent SDK or OpenAI Chat Completions),
provider, model ID, maximum turns, authentication, and your own per-million-token prices for input,
output, cache read, and cache write. Credentials are write-only. You can replace one, but the
platform will never show it back to you, and they are encrypted at rest. How a saved value resolves
against its environment fallback is described once in [Platform settings](settings.md); the
administration area as a whole is described in [Platform administration](administration.md).

### Environment fallback

Environment variables are a bootstrap convenience for a fresh deployment. Once a value is saved in
Platform settings, the saved value wins and the environment variable is ignored.

| Variable | Purpose |
| --- | --- |
| `LLM_PROVIDER` | Which runtime to start with: `claude` or `openai`. |
| `ANTHROPIC_API_KEY` | Claude with an API key. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude with a subscription token. |
| `ANTHROPIC_MODEL` | Claude model identifier. Defaults to `claude-opus-4-8`. |
| `OPENAI_API_KEY` and `OPENAI_MODEL` | OpenAI. Both are required together. |
| `ANTHROPIC_MAX_TURNS` / `OPENAI_MAX_TURNS` | Evidence-gathering rounds before the engine must conclude. Default 8. |
| `TRIAGE_JOB_DEADLINE_MS` | Ceiling on one investigation attempt, in milliseconds, measured from when the worker claims the job. When it passes, the engine is cancelled, the attempt is recorded as failed and retried once; a second timeout dead-letters the job. Default 900000 (15 minutes). |
| `TRIAGE_CONTEXT_WINDOW_MIN` | How far back the opening evidence pull reaches, in minutes. Default 60. |
| `TOOL_RESULT_MAX_CHARS` | Size cap on a single piece of evidence shown to the model. Default 6000. |
| `EVIDENCE_BUDGET_CHARS` | Starting size cap on the evidence carried into a continued investigation. Default 24000. Change it in Settings; this value applies only until a setting is saved. |
| `EVIDENCE_ROW_LIMIT` | Starting ceiling on how many past tool results one investigation reads back from storage, newest first. Default 1000. Change it in Settings; this value applies only until a setting is saved. |
| `TRANSCRIPT_BUDGET_CHARS` | Size cap on the conversation history carried into a continued investigation. Default 24000. |
| `RUNBOOK_SEED_SCORE_FLOOR` | How similar a past incident must be before it is offered as a lead. Default 0.75. |
| `DASHBOARD_BASE_URL` | Your dashboard address, so incident links work in Slack. Unset means no link. |

The two budget caps drop the oldest material first, so a long-running incident keeps its most recent
context.

## When an investigation runs too long

If an investigation exceeds its deadline, the run fails, the incident shows degraded or keeps its last assessment, and the job is retried once. If the worker cannot cancel the stuck run, it restarts itself and logs `job handler stuck past deadline; recycling process`.
Runbook, postmortem, grading, and classification calls are cancelled at the same deadline as the main triage engine loop. The API restarts itself the same way, through process exit and restart, if a founding or Slack-inbound background job ignores the deadline.

## What the model is allowed to do

On the Claude runtime, the model's built-in shell and filesystem access is switched off. It can only
call the platform's own read-only tools, scoped to the tenant that owns the incident. It cannot read
your repository checkout, run commands, or reach anything you have not connected.

Both runtimes are given the same investigation instructions, so the methodology does not change when
you switch provider.

## Cost, usage, and spending caps

Every model request is recorded before it is made, and completed with the tokens used, the request
count, and the cost calculated from your configured prices. The prices in effect at the time are
stored on each record, so editing today's prices does not rewrite what yesterday cost.

[Usage & Cost](../dashboard/usage.md) explains what the page reports and why it separates priced
work from unpriced and unreported work. The four spending caps are rolling 24-hour limits on
automatic investigations: a run count and a configured-cost limit per tenant, and the same pair per
monitor. Zero means unlimited. A platform administrator sets them under **Platform administration** →
**Platform settings** in the **Queue and automation** section; [Platform settings](settings.md)
lists each with its bounds and fallback.

The operator-relevant consequence is this: **a cost cap will not treat unknown cost as zero.** If
usage is still pending or unpriced, new automatic work pauses rather than risking an unbounded
spend, and a cost cap refuses to start automatic work at all until at least one price is
configured. An unpriced model is therefore an availability problem, not only a reporting gap.

Investigations you start yourself, and replies you send in a thread, are manual and are never
capped.

## Connecting your own tools

You can point an external client at a single incident and get the same read-only, redacted, audited
tools the platform uses itself.

```json
{
  "mcpServers": {
    "sre-incident": {
      "type": "http",
      "url": "https://api.example.com/mcp/incidents/<incident-uuid>",
      "headers": {
        "Authorization": "Bearer <access-token-with-mcp-scope>"
      }
    }
  }
}
```

Use the address that serves your API. The access token must belong to a current member of the
tenant, carry the `mcp` scope, and be able to see that specific incident. Access is deliberately
scoped to one incident at a time.

Every call through this endpoint is redacted and audited exactly as an internal one is. Connector
credentials are never exposed through it. A token without the right scope, an incident in another
tenant, and an oversized request are all refused before any connector is contacted.
