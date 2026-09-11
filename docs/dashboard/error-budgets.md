# Error budgets

How much unreliability each service has left, and how fast it is spending it.

## What an objective is

An objective names a service, the kind of reliability you care about (availability or latency), the
target you hold yourself to, and the rolling window the target applies over. It also carries the query
that measures it, which runs against your own metrics backend.

The gap between the target and 100% is the budget. A 99.9% availability target over 30 days is a
budget of 0.1%, which is roughly 43 minutes of that month. Spending budget is normal. Spending it
faster than the window allows is the thing worth knowing about.

## Defining an objective

Objectives are managed through the platform API today. Create, edit and delete them there. This panel
reports objectives and their budgets; it does not edit them.

## Writing the query

The query is yours, and it must resolve to a single number: the **bad-event ratio** in the range 0 to
1. For an availability objective that is failed requests divided by all requests. For a latency
objective it is requests slower than the objective's threshold divided by all requests. A value
outside 0 to 1 is rejected rather than stored, because it is not a bad-event ratio. The threshold
is recorded on the objective for your reference; nothing is substituted into the query for you, so the
expression has to name it itself.

### The window placeholder

Every scheduled run evaluates the query **twice**: once over the objective's compliance window, and
once over a short burn window, currently one hour. Write the literal token `$window` everywhere a
duration belongs. Each occurrence is replaced with the window being asked about, expressed in whole
seconds, before the expression reaches your backend. A 30 day compliance window becomes `2592000s`,
and the one hour burn window becomes `3600s`. Seconds are always a legal duration, so no window is
ever rounded into a different one.

An expression that contains no `$window` is sent unchanged. Both evaluations then ask the identical
question and get the identical answer, so the burn rate is pinned to one minus the budget remaining,
the short window measures nothing, and a real short spike can never show. Nothing errors, nothing is
skipped, and the objective simply reports a figure that never moves. If a budget looks suspiciously
steady, check the placeholder first.

### A worked availability objective

Target 99.9% over 30 days, for a service whose failures are HTTP 5xx:

```promql
(sum(rate(http_requests_total{service="checkout",code=~"5.."}[$window])) or vector(0))
/
sum(rate(http_requests_total{service="checkout"}[$window]))
```

On each run that is evaluated once with `[2592000s]` for the budget and once with `[3600s]` for the
burn rate.

### A worked latency objective

Target 99% of requests faster than 300 ms over 7 days. The histogram bucket gives the fast fraction,
so the bad ratio is its complement, and the bucket boundary is where the 300 ms threshold appears:

```promql
1 - (
  sum(rate(http_request_duration_seconds_bucket{service="checkout",le="0.3"}[$window]))
  /
  sum(rate(http_request_duration_seconds_count{service="checkout"}[$window]))
)
```

Both halves of that ratio come from the same counters, so a service that is serving traffic always has
a numerator. A service with no traffic at all in the window has neither, and the whole expression
resolves to nothing. If you would rather record a zero for an idle window than no figure at all, wrap
the entire expression the same way, with `or vector(0)`, and read that zero as "nothing was measured"
rather than as perfect reliability.

### Queries that can match nothing

An expression whose selector matches no series returns an empty result, not a zero. The platform
rejects an empty result rather than reading it as a perfect score, and that evaluation is dropped, so
nothing is recorded for the window. Any part of an expression that can legitimately match nothing
must therefore be wrapped so that it resolves to zero instead, which is what `or vector(0)` does in the
availability example above. The most common symptom is an objective that stays on **Awaiting first
evaluation** while the service is healthy: with no failures there are no error series, so the query
never produces a number. The row says so: a dropped evaluation records why it was dropped, and that
reason appears on the objective.

## Reading a row

| Field | What it tells you |
| --- | --- |
| Objective and service | What is being measured, and for which service |
| Target and window | The reliability target and the rolling window it applies over |
| Budget left | How much of the allowance remains. Over budget is stated as an overage, never as a negative |
| Burn | How fast the budget is going, over the short window named beside it. A burn of 1 is exactly on track to spend the whole budget across the window |
| Exhaustion | Days until the budget reaches zero at the current burn |

An objective the evaluator has not reached yet reads **Awaiting first evaluation** rather than showing
a zero. A disabled objective is marked, because the evaluator stops refreshing it and its last figure
goes stale.

### When an evaluation fails

An evaluation that cannot produce a number records why, and the row shows **Evaluation failing** with
the reason and how long it has been failing. This is how you tell a broken objective from a new one:
both can read **Awaiting first evaluation**, but only the broken one carries a reason. The most common
reasons are a query the backend rejected, a query that matched nothing, and no connector of the
objective's type being configured.

The reason appears beside the last good figures rather than in place of them. An objective that
evaluated successfully for weeks and then started failing keeps showing its last measurement, so you
can see both the number and the fact that it stopped being refreshed. A later successful evaluation
clears the reason on its own, so a backend outage does not leave the objective marked broken. The
time shown is when the current failure started, not when it was last retried, so a reason that has
been there for days tells you the objective has been failing for days.

## Where the numbers come from

Every figure resolves to a query you wrote. A scheduled evaluation asks your metrics backend for the
ratio over the compliance window and again over a short burn window, computes the budget and the burn
rate from those two answers, and stores that single result. The underlying samples stay in your
metrics backend, which remains the source of truth for them.

If no connector of the objective's type is configured, the evaluation is skipped rather than guessed
at. An objective with no result yet keeps awaiting its first one. An objective that already has a
result keeps showing that last figure until evaluations resume, so check the time it was computed,
which the panel shows beside it, before trusting a number that has stopped moving.

An objective names a connector **type**, not a particular connector. If you have connected two
Prometheus instances, every objective of that type reads the same one, chosen so the choice is stable
rather than arbitrary, and there is no way today to point one objective at the other instance. Until
that changes, keep the objectives for a service on a single instance: measure the service from the
backend that actually scrapes it, and if two instances scrape different services, expect only the
services covered by the chosen instance to produce meaningful ratios.

## What the budget does, and what it never does

The budget is read only. It appears in an incident's opening brief so a responder knows what the
service had left, it stamps a deployment as high risk when the service is nearly out, and it feeds
this page.

It never opens an incident, pages anyone, or blocks a deploy. There is deliberately no button here
that does any of those things. If a fast burn genuinely needs a human right now, that belongs to your
alerting provider, which is already built to wake people up. This platform reports.
