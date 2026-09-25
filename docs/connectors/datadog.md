# Datadog

Read logs, spans, events, error tracking and metrics from your Datadog organisation.
This connector gathers investigation evidence and can receive authenticated monitor lifecycle events.

## What it adds to an investigation

Use metrics to check symptoms, then inspect logs and available traces for possible causes.

## How it is wired

```mermaid
flowchart LR
    Inc["An investigation<br/>needs evidence"] --> Tools["Read-only tools"]
    Tools --> Dog["Datadog"]
    Dog --> Scrub["Result scrubbed<br/>of secrets"]
    Scrub --> Thread["Evidence in the<br/>incident thread"]
```

Investigation tools read data on demand. Separately, automatic topology discovery reads bounded
batches of hosts, monitors and Software Catalog declarations. APM span discovery is optional.
These background reads never create incidents or modify Datadog.

## Topology without APM

Leave **Collect APM service-call evidence** off if your organization does not have indexed APM
spans. New connections start with this option off; existing connections preserve their previous
behavior until you change it. Hosts, monitors and catalog declarations are collected independently,
and metrics and logs remain available during investigations.

Host discovery requires `hosts_read` and monitor discovery requires `monitors_read`. A denied
collection does not erase earlier evidence or stop unrelated collections; a rate limit pauses
further discovery requests for the connection.

An unambiguous `service` tag can declare a host association or monitor scope. Conflicting service
or environment tags remain unresolved. Hosts with no service tags still appear as infrastructure;
co-location and similar names do not establish service calls. Topology does not retain host
metadata, monitor queries, messages or unrelated tags.

## Before you start

| You need | Why |
| --- | --- |
| Your Datadog site | Requests are restricted to supported Datadog endpoints |
| An API key | Required for every read |
| An application key with read permissions | Required for the data you want to query |

Supported sites: `datadoghq.com`, `us3.datadoghq.com`, `us5.datadoghq.com`, `datadoghq.eu`,
`ap1.datadoghq.com`, `ap2.datadoghq.com`, `uk1.datadoghq.com`, `ddog-gov.com`, `us2.ddog-gov.com`.

## Connect it

Open **Connections**, choose **Add connection**, then **Add Datadog**.
See [Set up a connector](setup.md) for the shared setup workflow.

### 1. Connection

![Naming the connection and choosing a Datadog site](../assets/screenshots/add-datadog-1-connection-light.png#only-light)
![Naming the connection and choosing a Datadog site](../assets/screenshots/add-datadog-1-connection-dark.png#only-dark)

Name the connection and select the site where your Datadog organisation is hosted.

### 2. Credentials

![Pasting the Datadog API and application keys](../assets/screenshots/add-datadog-2-credentials-light.png#only-light)
![Pasting the Datadog API and application keys](../assets/screenshots/add-datadog-2-credentials-dark.png#only-dark)

Enter the API key and application key. They are stored encrypted and sent in request headers,
not URLs.

### 3. Review

![Reviewing the Datadog connection](../assets/screenshots/add-datadog-3-review-light.png#only-light)
![Reviewing the Datadog connection](../assets/screenshots/add-datadog-3-review-dark.png#only-dark)

Check the provider, endpoint and access mode. Keys are not displayed.

### 4. Verify

Verification checks the API key and attempts a monitor read with the application key.
It does not verify access to every optional discovery API.

This step runs against your real system, so it is not pictured here.

## What it can read

Enable **Discover traffic from logs** when editing the connection to add bounded request evidence
to topology. This is separate from APM and uses the existing log-read permission. It is off until
you enable it, including for existing connections after an upgrade.

The platform scopes these reads to cluster and namespace pairs reported by this workspace's enabled
Kubernetes inventory connections, capped at 64 pairs per sample. Namespace-restricted connections
do not authorize logs from other namespaces. Connect Kubernetes first if coverage reports a missing scope.
Logs must include the matching cluster identifier, namespace and pod name. A service label alone
does not identify a runtime component.

Supported evidence includes ingress-nginx upstream access logs and completed structured gRPC
client/server records. Loopback calls, malformed records and ambiguous identities do not create
cross-workload dependencies. Database or Redis counters alone do not identify a destination.

Every collection samples up to three request formats, with at most 200 records per format, from
a fixed ten-minute window. More provider results are reported as partial coverage rather than
silently presented as a complete graph. A provider rate limit stops further reads in that attempt.
Subsequent scheduled reads respect a bounded provider cooldown, at least five minutes.

The map preserves request direction, response versus attempt, evidence time and resource type.
Service virtual IPs remain Service endpoints; their backing pods are routing context, not proof
of which pod handled a request. Endpoint matches require inventory observations that bracket the
log's timestamp, so a new connection may need another collection before links resolve.
Host-network Pod addresses are not exclusive identities. Changed or retired endpoint bindings
are retained for up to 24 hours, bounded to 32 prior bindings per resource and the inventory size
limit. A historical call stays attached to its original identity, not an IP's replacement owner.

Repeated samples do not refresh an edge's event time. Retained log relationships expire after
24 hours on subsequent collection and may become stale sooner. Empty samples do not prove that
a dependency disappeared. Raw log messages, request parameters and credentials are not stored
as topology evidence.

### Investigation tools

--8<-- "_generated/connector-tools/datadog.md"

Tools are read-only, including POST search requests. Search domains are fixed; the model cannot
supply an arbitrary API path. Time ranges accept timestamps or relative expressions such as
`now-15m`. Requests time out after eight seconds and refuse redirects.

## Secrets in results

Tool results pass through shared credential redaction and size limits. Redaction cannot guarantee
that every secret in application text is recognized. Restrict key permissions and avoid logging
credentials in the source system.

## Native alert lifecycle

Enable **Receive authenticated alert lifecycle events**, select a subscribed Slack channel, and
configure a separate webhook bearer token. Send events to the displayed public API webhook path.
In Datadog's webhook integration, use `Authorization: Bearer YOUR_CONFIGURED_TOKEN` as a custom
header and configure this JSON payload:

```json
{
  "alert_id": "$ALERT_ID",
  "alert_scope": "$ALERT_SCOPE",
  "alert_cycle_key": "$ALERT_CYCLE_KEY",
  "alert_transition": "$ALERT_TRANSITION",
  "alert_title": "$ALERT_TITLE",
  "date": "$DATE"
}
```

These are [documented webhook variables](https://docs.datadoghq.com/integrations/webhooks/).
Transitions are handled as follows:

| Transition | Effect |
| --- | --- |
| `Triggered` | Opens or updates the exact cycle's episode. |
| `Re-Triggered`, `Renotify` | Re-drives an episode that a `Triggered` delivery, or an exact cycle binding, already established. A repeat never opens or dates a cycle by itself, because it carries the time it repeated rather than when the cycle began. With no established cycle it is acknowledged. |
| `Recovered` | Resolves the exact cycle's episode. |
| `Warn`, `Re-Warn`, `No Data`, `Re-No Data` | Acknowledged and never page. |

Acknowledged deliveries answer HTTP 200 and change no incident. They count as received deliveries
but never clear an earlier delivery diagnostic. A transition Datadog adds later is acknowledged the
same way rather than being treated as a malformed payload. If a `Triggered` delivery is lost, a later
repeat does not recover it; Datadog retries a delivery that fails to connect or receives a server
error. Datadog sends `Recovered` for recovery from Warn and No Data as well as from Alert, so a
recovery for a cycle that never alerted is retained as pending, the same as a recovery that arrives
before its trigger. The exact monitor, group scope,
and opaque cycle jointly identify an episode. A recovery received before its trigger remains
pending without an invented start timestamp. A late recovery cannot clear another cycle.

Exact-state reconciliation additionally requires both read keys and `monitors_read`. It refuses
missing groups, unknown state, and historical episodes the current group no longer proves.
Authenticated events for retained historical cycles still resolve their exact episodes after a refire.

Connections shows the number of recovery episodes waiting for their original trigger, even when a
later unrelated webhook succeeds. Replay the authenticated trigger with the same monitor, group,
and cycle identifiers, or review provider history. The platform does not substitute receipt time for
a missing trigger. Credential changes require fresh verification before an old pending recovery can
authorize closure.

## Associating historical Slack records

Datadog's current monitor API exposes trigger time; its webhook exposes the opaque alert cycle key.
Those values are different identities. API read binding and reconciliation work without a cycle key,
but do not establish native deduplication. For native adoption, enter `alert_cycle_key` from a retained
authenticated provider payload in **Native alert cycle key**, preview the exact monitor/group/episode,
and save with an audit reason. The platform stores only the scoped cycle digest. Matching authenticated
trigger delivery confirms the association and reuses the original Slack root. A different cycle stays
separate, and one historical binding cannot be reassigned to another opaque cycle.

Resend the exact retained `Triggered` JSON to the displayed webhook endpoint with its configured bearer
credential kept private. This means an authenticated HTTP request, not an assumed Datadog UI replay
button. If the payload or key is unavailable, use API read reconciliation; native association cannot be
established from title, URL or trigger time alone. A new native intake matching a read-only binding's
monitor/group/start remains pending until an explicit cycle association and authenticated replay.

If a native incident already exists, binding returns its canonical incident link without changing the
legacy record. Review both records and use the existing audited incident resolve/close action for
administrative supersession of the duplicate. That action is not proof of provider recovery or past
service health; rebinding cannot merge existing incidents.

A recovery timestamp before its paired trigger is retained as `conflicting_episode_times`; resend a
corrected authenticated recovery for that exact cycle. A trigger contradicting an explicitly bound
start remains `binding_episode_mismatch`, without posting a new root. Review the provider payload and
resend the corrected trigger. These unresolved diagnostics remain visible even if another cycle's
webhook succeeds. Neither conflict can authorize automatic closure.

A delivery whose configured Slack channel is not subscribed is reported as
`alert_channel_not_subscribed` and posts nothing. The webhook answers HTTP 503 so the provider
retries it. Subscribe the channel, then resend the authenticated delivery if the provider's retries
have already stopped.
