# Prometheus and Alertmanager

Reads your Prometheus over its HTTP API. Alertmanager delivery is a separate, optional capability on
the same connection: Alertmanager posts notifications to an endpoint belonging to this connector,
and those become incidents.

The read credential and the delivery credential are different. A Prometheus API credential is never
reused to authenticate anything inbound.

## What it adds to an investigation

Two things, and they are independent. **Reading** lets an investigation ask your metrics questions.
**Delivery** lets a firing alert open an incident that already knows when it started and when it
cleared.

## How it is wired

```mermaid
flowchart LR
    Am["Alertmanager"] -->|"pushed to a delivery<br/>endpoint, optional"| Incident["An incident that knows when<br/>the alert fired and cleared"]
    Incident --> Ask["The investigation<br/>asks for numbers"]
    Ask --> Tools["Read-only tools"]
    Tools --> Prom["Prometheus read API"]
    Prom --> Thread["Evidence in the<br/>incident thread"]
```

Two paths, two credentials, and either one works without the other. Prometheus itself is never
polled: reads happen only while an investigation is running. Delivery is what gives an incident its
real firing and recovery times, rather than the time a human noticed.

## Before you start

| You need | Why |
| --- | --- |
| A Prometheus address the platform can reach | A private network address is allowed here |
| One authentication method, from the table below | Saving without one is rejected |
| Your certificate authority, for a self-signed certificate | Server trust is separate from authentication |
| An Alertmanager receiver you can edit, for delivery | Optional. You can connect reads only |

## Address and transport

Prometheus is self-hosted and usually lives on a private network, so a private address is allowed
here. Loopback, link-local, and cloud metadata addresses are refused. During local development the
supervised tunnel on `http://127.0.0.1:9090` is admitted; a deployed process never admits it.

Plain HTTP has no encryption and requires you to acknowledge that during setup. Use it only through
that tunnel or on a trusted private network, and use HTTPS whenever credentials or monitoring data
cross anything else. Mutual TLS requires HTTPS.

Requests carry the credential in a header and never in the address, time out after eight seconds,
and refuse redirects.

## Authentication

Prometheus has no single authentication convention, so pick the one your deployment uses.

| Method | What you supply | How it is sent |
| --- | --- | --- |
| None | Nothing | Unauthenticated, for a bare in-cluster Prometheus |
| Bearer token | A token | An `Authorization` header. Grafana Cloud, Thanos, an OAuth proxy |
| Basic | A username and password | An `Authorization` header. An nginx-fronted Prometheus |
| Custom header | A header name and value | That header. Cortex and Mimir tenant headers, API-key proxies |
| Client certificate | A certificate and key | Presented during the TLS handshake |

A client certificate over plain HTTP is rejected. Amazon Managed Prometheus, which signs requests,
is a documented future addition to the same set.

Server trust is separate, because a Prometheus behind basic authentication can still serve a
self-signed certificate. Pin your own certificate authority, or explicitly choose to skip
verification.

## Connect it

Open **Connections**, choose **Add connection**, then **Add Prometheus & Alertmanager**. Five
steps, and the last three exist only because delivery is optional. The catalog and the shape every
wizard shares are in [Set up a connector](setup.md).

### 1. Metrics endpoint

![Choosing the Prometheus endpoint](../assets/screenshots/add-prometheus-1-endpoint-light.png#only-light)
![Choosing the Prometheus endpoint](../assets/screenshots/add-prometheus-1-endpoint-dark.png#only-dark)

The address and the authentication method. A private network address is allowed here, because
Prometheus is usually self-hosted. The wizard says plainly that investigations query this endpoint
on demand and that nothing is polled or copied.

### 2. Metrics credential

![Supplying the Prometheus credential](../assets/screenshots/add-prometheus-2-credential-light.png#only-light)
![Supplying the Prometheus credential](../assets/screenshots/add-prometheus-2-credential-dark.png#only-dark)

The secret for the method you picked, plus a certificate authority if your server uses one. If you
chose no authentication there is nothing to enter.

### 3. Alertmanager delivery

![Choosing how Alertmanager reaches the platform](../assets/screenshots/add-prometheus-3-delivery-light.png#only-light)
![Choosing how Alertmanager reaches the platform](../assets/screenshots/add-prometheus-3-delivery-dark.png#only-dark)

Independent of reading, and optional. Choosing a delivery mode gives Alertmanager an
endpoint to post to, which is what lets a firing alert open an incident that already knows when it
started and when it cleared. **Configure later** leaves reading fully working and alerts simply not
arriving.

Once you pick a mode, the step also states the episode policy, because it is not something you
configure: each provider episode opens its own incident and its own Slack thread, and episodes that
arrive close together are compared afterwards rather than folded into one workspace.

### 4. Review

![Reviewing the Prometheus settings](../assets/screenshots/add-prometheus-4-review-light.png#only-light)
![Reviewing the Prometheus settings](../assets/screenshots/add-prometheus-4-review-dark.png#only-dark)

Settings only. Review does not save: the connector and any local relay change only after the next
step.

### 5. Verify

The credential is encrypted before it is stored. Verification runs a trivial query, and the
connector is switched on only if it succeeds.

This step runs against your real system, so it is not pictured here.

## What it can read

--8<-- "_generated/connector-tools/prometheus.md"

Nothing here can change anything. The two query tools send their parameters in a request body, which
avoids the length limit on long queries, but they post to one fixed read path. The general-purpose
tool is read-only, confined to the API path, and normalised so that a relative path cannot escape
it. No tool accepts an HTTP method, and the endpoints that would delete data need methods no tool
can use.

Time ranges accept either an exact timestamp or a relative expression such as `now-1h`, anchored to
when the incident started.

## Alertmanager delivery

During setup you choose how notifications reach the platform: a public HTTPS endpoint in a deployed
environment, a relay in local development, or nothing at all. Choosing nothing is valid, and the
connector card then says event delivery is not configured rather than looking complete.

Use one incident-ingestion owner for each provider route: direct provider Slack delivery, or native
Alertmanager delivery through the platform. Sending both copies into subscribed channels can create
separate incidents. A rendered Slack alert does not share the native connector, fingerprint and start
time identity, and matching titles do not prove that two copies are the same episode.

For native delivery, first connect Slack, invite the bot to the destination channel, and enable that
channel's **Listen** subscription on **Inbound**. Copy the generated webhook configuration into the
selected receiver with its matching bearer token and `send_resolved: true`. Preserve receiver names,
route matchers, grouping and null/control routes. Change only the selected route's notification owner;
do not remove unrelated receivers or independent notification coverage.

Native delivery makes the platform and its Slack posting credential part of notification delivery.
The provider webhook is accepted only after a root is durably bound to the incident. If a post has an
ambiguous external outcome, intake remains uncertain: later notifications can return deferred status
without accepting the incident. There is no exactly-once Slack delivery or automatic uncertain-intake
repair guarantee. Inspect the recorded delivery status and actual Slack root before an operator acts.
If independent urgent notification coverage is required, use a separately approved destination
outside this incident intake.

### Change ownership without abandoning active episodes

Before switching, inventory active provider episodes and their existing incidents and threads. Keep
the current owner until its final provider clears are durably recorded. Account for pending and
in-flight notifications, and confirm that no episode is active at the boundary. Stop and reconcile
any firing notification that races the switch. Native activation does not backfill, deduplicate or
clear old Slack incidents.

For a condition that cannot drain, an operator must first verify the exact old-to-new episode mapping
and explicitly audit any supersession or signal correction. Retain a case for the live condition and
link the evidence. An administrative correction is not provider-confirmed recovery. If exact mapping
is unavailable, keep the current owner and investigate rather than infer identity or health.

### Validate an isolated route before wider cutover

An owner or admin should use a synthetic provider route and an enabled destination subscription.
Verify one visible Slack root, one incident and one initial investigation; replay the same firing
notification and confirm no duplicate work. Send its exact resolved notification, then a new start
time to verify independent recurrence. Inspect Slack event delivery to confirm the native opener's
ownership marker survived, and check observable delivery failures as well as successes. A metrics
read alone does not verify this path.

Native openers retain a normal inbound receipt when Slack echoes them. Verified owned echoes do not
start classification or another investigation. Unmarked same-app provider roots and authorized
human replies still use ordinary intake. New native episodes require an enabled destination
subscription. If it is revoked during a successful post, the root is retained without opening an
incident; resubscription allows the provider retry to route that root without reposting. Accepted
episodes continue receiving authoritative provider updates and recovery after a subscription change.

For rollback, apply the same active-episode drain or explicitly mapped reconciliation before
restoring direct Slack ownership. Direct Slack notifications cannot update an active native identity.
Verify notification visibility, preserve the audit trail and avoid simultaneous intake owners or
silently abandoned native updates.

Saving stores a draft that is switched off. A successful verification switches it on and starts
delivery. The connector card reports read access and delivery health separately, so a connection
that can only query cannot appear fully configured.

The endpoint rejects anything unauthenticated, malformed, oversized, truncated, or of an unexpected
version.

### What a notification does

A grouped notification is split into separate alerts. Each one is identified by the connection it
came from, Alertmanager's own fingerprint, and when it started.

```mermaid
flowchart TD
    Note["A notification arrives"] --> Kind{"What changed?"}
    Kind -->|"Nothing"| Fresh["Refresh how current<br/>the alert is. No model run"]
    Kind -->|"An annotation only"| Ignore["Ignored for<br/>investigation purposes"]
    Kind -->|"Severity, entity,<br/>impact or cause"| Reassess["New version of the signal,<br/>and a reassessment"]
    Kind -->|"Resolved"| Verify["Start recovery<br/>verification"]
```

A reassessment is narrow when the incident already has a trusted assessment, and complete otherwise.
If the very first notification is already resolved, the platform still assesses it and then
schedules the recovery check.

Labels are read for what they honestly are. A job name is monitor scope and a namespace is runtime
scope; neither is promoted to a service in your catalog. You can map a candidate to a catalog
service yourself, and doing so does not rewrite what the provider actually said.

### A new alert always gets a new incident

A new start time creates a new alert episode, independently investigated incident, and Slack thread.
The earlier occurrence remains recurrence history. Matching monitor identity and arrival time never
reuse its workspace.

### Alerts that arrive together

Alerts from the same connection inside one burst window, 120 seconds, are grouped as a cohort.

A cohort seals its members before analysis and exposes at most five independent incidents to one
budget-admitted model call. It can record only a possible relationship or that two incidents are
unrelated. Timing never proves a cause and never merges records.

A possible relationship starts one focused causal reassessment. The platform creates a directed
cause only when a conclusive investigation cites durable evidence, meets the confidence threshold,
and the candidate is still current. Each symptom can have one direct cause and the graph cannot
contain a cycle. The direct cause owns coordinated recovery and lifecycle; every incident keeps its
own evidence, conversation, and Slack thread.

You can merge incidents only after both investigations finish, and only with a reason and evidence.
Splitting them again restores the original signals, threads, and states. Every causal, unrelated,
merge, split, and rejection decision remains in the audit trail.

### Live Alertmanager and Slack acceptance

The repository acceptance harness starts a pinned official Alertmanager against an empty isolated
database and a fake investigator. It verifies exact-repeat suppression, one material reassessment,
resolved and refired episodes, bounded cohort analysis, an evidence-backed causal response root,
complete-group recovery, binding-scoped Slack receipts, and reversible merge and split. The harness
closes its synthetic incidents and fails if any run-owned container cannot be removed.

## Secrets in results

This connector has no redaction rules of its own. Prometheus already masks structured credentials in
its own configuration endpoint.

The residual case is a credential written into an address, such as a username and password in a
scrape target, which is
[known Prometheus behaviour](https://jfrog.com/blog/dont-let-prometheus-steal-your-fire/). That is
the same limit that applies to any log line. Your egress rules and per-customer credential isolation
remain the real controls.
