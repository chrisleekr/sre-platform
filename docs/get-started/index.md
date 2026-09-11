# Get started

Three steps to a working platform, in this order.

Creating a workspace on an existing installation? Follow
[Create your workspace](create-your-workspace.md).
Already have one? Start with [Sign in](sign-in.md).

## 1. Install it

[Install locally](local-development.md) brings up the whole stack with Docker: the database, the
queue, the API, the dashboard, and the workers.

Installing on your own infrastructure instead? Start at [Container image](../operate/container.md),
which lists what each process needs before it starts and the order to run them in.

## 2. Connect Slack

[Connect Slack](connect-slack.md) is the one integration that is not optional. Slack is how signals
get in and how answers get back out. Until a channel is subscribed, nothing arrives.

## 3. Connect at least one data source

Without a data source the platform can hold a conversation but cannot investigate anything.

Start with the evidence your responders reach for first. For most teams that is
[Kubernetes](../connectors/kubernetes.md) for runtime state and
[Prometheus](../connectors/prometheus.md) for the alerts themselves, then a source-control connector
so it can see what changed.

Every connector is read-only, and each one is set up on its own page under
[Connect your tools](../connectors/index.md).

## Then what

Subscribe a channel that already receives alerts and wait for one. The investigation appears in that
alert's thread, and the same conversation is on the dashboard with the full evidence trail.

If nothing happens, [Inbound](../dashboard/inbound.md) tells you what the platform did with every
message it saw, including the ones it decided not to act on.
