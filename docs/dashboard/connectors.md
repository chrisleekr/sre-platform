# Connections

Which of your systems the platform is allowed to read. Any member can read this page. Every action
here that changes or re-checks saved configuration, on a connection or on the Slack connection and
its channel subscriptions, is reserved to a workspace owner or admin, and is refused during a
platform support session.

## Your connections

The page opens on saved connections. Search by name, provider, or scope, filter by provider, or
select **Needs attention** to find unfinished setup and reported failures. **Access** and **Data
activity** are separate: a successful access check does not prove that polling or events work.

Open a connection to review its evidence and configuration. Its address can be bookmarked or
shared with another workspace member. **Back to connections** returns to your filtered inventory.

## Add connection

**Add connection** opens the searchable provider catalog: evidence providers and Slack, filtered by
category, each card showing how many connections you have saved. The click path, the shape every
wizard shares, and what Review and Verify do are in [Set up a connector](../connectors/setup.md);
each provider's walkthrough is a page in [Connect your tools](../connectors/index.md).

## Access and activity

Each saved source shows its scope and the latest recorded evidence. Inventory labels include:

| Badge | Means |
| --- | --- |
| **Verified** | Access was proved at a point in time, and the source is switched on |
| **Not verified** | Saved, but never checked |
| **Verification failed** | The last check could not read what it needs |
| **Credential missing** | Configured, but with no usable stored credential |
| **Disabled** | Saved and switched off |
| **Events not configured** | Optional event delivery was left unset |
| **Awaiting first event** | Delivery is configured but no successful event is recorded |
| **Event delivery failed** | The latest event delivery reported a failure |
| **Polling failed** | Polling or a project's snapshot reported a failure |
| **Snapshot received** | A successful snapshot was recorded |
| **On demand** | Reads run during investigations rather than continuous polling |

Verification is a point-in-time proof, not a promise. A token revoked an hour after it was checked
still shows as verified until the next check, which is why polling status and event delivery are
shown next to it: together they tell you whether the source is still producing usable data.

## Actions in connection details

| Action | Does |
| --- | --- |
| **Manage** | Reopens the setup wizard with your saved settings, to change scope or replace the credential |
| **Retest** | Re-checks access now and updates the status |
| **More actions → Disconnect** | Deletes the configuration and the credential, after a confirmation |

Slack details use **Edit Slack** for credentials; **Inbound** focuses on channel subscriptions and
message processing. How to change scope, rotate a credential, and disconnect is in
[Set up a connector](../connectors/setup.md#manage-existing-connections).

## Connector against data source

A connector is the integration; a data source is one configured instance of it. The distinction is
explained in [Connect your tools](../connectors/index.md#connector-against-data-source), and what
every connector can and cannot do in
[What every connector has in common](../connectors/index.md#what-every-connector-has-in-common).
For how connectors reach your network safely, see [Network policy](../operate/network-policy.md).

## Alert lifecycle and existing incidents

Each connection declares alert lifecycle coverage independently of investigation tools or generic
repository events. Evidence-only and incomplete connectors cannot authorize automatic recovery.
Unknown notifications remain visible, with strict recovery policy and an unresolved signal state.
AI may suggest a recovery, but wording and model output do not change provider lifecycle.

For an existing incident, open its connection's **Alert lifecycle coverage** panel:

1. Select the open incident by title, then its provider signal by summary. The list holds up to the
   100 highest-priority open incidents and says when more are open.
2. Enter the exact provider monitor ID and, for Datadog, the exact group scope.
3. Preview the provider episode and check its timing and current result.
4. Enter a reason and bind the verified episode. A concurrent signal, lifecycle, or connector change
   invalidates the preview and requires a fresh check.
5. Select **Provider signals clear** in the incident's existing resolution policy control, then
   reconcile the connection. Original notification evidence remains in the audit trail.

StatusCake uptime and exact Datadog group reads support bounded reconciliation. Native Alertmanager
and Grafana recovery uses authenticated event replay. Unsupported families, missing permissions,
missing history, conflicts and stale generations produce a visible reason instead of inferred
health. Existing regex-derived provider labels alone do not establish verified recovery.

Route the provider webhook paths directly to the API behind your reverse proxy, without an
interactive browser-login challenge. Provider authentication remains required. The application
supports `/webhooks/alertmanager/`, `/webhooks/datadog/`, `/webhooks/grafana/`, and the per-test
StatusCake endpoints the platform creates; deployment-specific proxy allowlists must include the routes you enable.

Current provider verification and accepted recovery evidence are separate. A verified firing read
shows the current provider state while preserving the historical notification. It does not authorize
closure. The additive `provider_clear_generation` signal field records only an accepted exact
provider clear under the current connector generation. Existing records start without this proof;
reconciliation must obtain fresh exact recovery evidence before queued automatic closure can proceed.
Changing credentials or connector settings requires re-verification under the new generation.
