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

If an investigation exceeds its deadline, the run fails, the incident shows degraded or keeps its last assessment, and the job is retried once. Data source tool requests still in flight are cancelled at the same moment rather than running to their own timeout, and no further tool calls start. If the worker cannot cancel the stuck run, it restarts itself and logs `job handler stuck past deadline; recycling process`.
Runbook, postmortem, grading, and classification calls are cancelled at the same deadline as the main triage engine loop. The API restarts itself the same way, through process exit and restart, if a founding or Slack-inbound background job ignores the deadline.

A job that fails its last allowed attempt is dead-lettered. The [Work queue](../dashboard/work-queue.md) page lists every dead job in your workspace with a link to its incident, where you can retry it.

## When evidence review rejects a conclusion

A rejected conclusion is recorded as inconclusive and never replaces the trusted assessment. Its
causes, hypotheses, impact, and recommended action are withheld. The summary keeps only the facts the
evidence supports, each missing proof becomes an open check, and the next step is the reviewer's
safest diagnostic step when it names one. Without a reviewer step, the next step asks the responder
to review the preserved evidence before relying on the conclusion.

Any inconclusive finding posts to Slack as **Unverified**, followed by its next step and, when the
evidence review named them, up to three open checks under **Still to verify**.

Reviewer text longer than its limit is cut at the last complete sentence for short fields, such as
the summary, an open check, or the next step, when that keeps most of the text. Otherwise, and for
long fields, it is cut and marked with an ellipsis.

## When evidence review cannot complete

An incomplete review means the platform could not verify the assessment. It does not prove that
the service is still unhealthy or that the evidence contradicts recovery. The incident stays open,
retains the prior trusted assessment, and shows the current review blocker with a next action. The
summary starts with "Evidence review did not complete" and states the blocker.

Large evidence records are reviewed in bounded slices before a final assessment. Slice notes retain
observation times, units, uncertainty, and conflicting facts. A slice that cannot retain its material
findings within the limits stops that review; partial coverage cannot authorize resolution.

When review of an assessment or reply stops on its own size limits, the platform reviews once more
using only the records the conclusion cites, including records its hypotheses name as contradicting
it. The reviewer is told that uncited output was not reviewed and that its absence proves nothing. If
the conclusion cites no records, or cites every record, the original blocker stands. Recovery
verification never takes this cited-records review: a recovery check that stops on size limits needs
a human, because partial coverage cannot authorize resolution. A reviewer note or corrected field
that is longer than its limit is shortened rather than treated as a failed review. A list with more
entries than its limit is never shortened, because dropping entries would drop findings; it fails
validation instead.

Validation blockers identify whether the failure happened in a single review, a slice, or final
synthesis, with bounded schema details. They do not include raw provider responses or evidence.
Request a focused recovery check. If validation keeps failing, inspect the review service logs.
For a budget blocker, narrow the service or evidence window in the follow-up request. For an
availability blocker, restore the review service before requesting another check. These requests
use the existing incident conversation; apart from the one cited-records review above, the platform
does not retry an incomplete review automatically.

The full review summary remains in the investigation history and recovery assessment when a shorter
blocker preview is shown. A recovery review can schedule another observation only with a bounded
recheck outcome and an explicit delay and reason. Recovered and human-action outcomes carry no
recheck schedule. A malformed combination stays unverified until a valid review completes.

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

After upgrading, replace existing `/mcp/incidents/<incident-uuid>` client addresses with
`/mcp/providers/<sign-in-method-uuid>/incidents/<incident-uuid>`. The old address and its
OAuth discovery address return `410 Gone` with migration instructions. Select the sign-in
method that issued your token, then reconnect the client so it discovers the new address.
The server cannot choose a sign-in method for an old client address.

```json
{
  "mcpServers": {
    "sre-incident": {
      "type": "http",
      "url": "https://api.example.com/mcp/providers/<sign-in-method-uuid>/incidents/<incident-uuid>",
      "headers": {
        "Authorization": "Bearer <access-token-with-mcp-scope>"
      }
    }
  }
}
```

Use the address that serves your API. The address names two things: the sign-in method that issued
your token, and the incident. Any active OIDC sign-in method qualifies, including an installation
sign-in method, which is the usual case for a staff token. Local password sign-in methods cannot
address this resource. The access token must have been issued
by that same sign-in method, belong to a current member of the tenant, carry the `mcp` scope, and be
able to see that specific incident. A token from a different sign-in method is refused exactly as an
invalid one is, so naming a sign-in method in the address never grants access the token does not
already carry. Access is deliberately scoped to one incident at a time.

Both identifiers are ones the platform already uses. The incident identifier is the last part of the
incident's address in the dashboard. The sign-in method identifier is the provider ID the platform
embeds in the per-method addresses it generates on the **Authentication** tab of **Workspace
settings**, such as the [back-channel logout URL](auth.md#ending-sessions-from-the-directory) or
the [SCIM base URL](auth.md#provisioning-people-with-scim). For an installation sign-in method, ask
a platform administrator for it.

A client that supports OAuth discovery still needs the complete address, because discovery starts
from it. What discovery saves you is naming an authorization server by hand: the address publishes
its own protected-resource metadata, and that metadata advertises exactly the one authorization
server able to mint a token for it.

Every call through this endpoint is redacted and audited exactly as an internal one is. Connector
credentials are never exposed through it. A token without the right scope, a token from another
sign-in method, an incident in another tenant, and an oversized request are all refused before any
connector is contacted.
