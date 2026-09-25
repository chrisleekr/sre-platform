# Slack

The platform talks to people in two places: the dashboard, and Slack.

Both show the same conversation. Every incident has one canonical thread of record, and each surface
is a view onto it. Replying from Slack and replying from the dashboard reach the same place, so two
responders working in different tools still see one another's messages.

To set Slack up for the first time, follow [Connect Slack](../get-started/connect-slack.md). This
page covers what to expect once it is connected.

## Answers appear in the alert's own thread

There is no "post replies here" channel to configure, and this is deliberate. The platform answers in
the thread the alert arrived in, so the investigation sits directly under the alert that caused it.

The practical consequences:

- Whoever can see the alert can see the answer. You do not need to remember where output goes.
- Muting the alert channel mutes the investigation with it.
- If an incident was declared from the dashboard rather than raised by an alert, it has no Slack
  thread. It lives on the dashboard only.

## Connecting, channels, and disconnecting

The procedure for connecting, rechecking tokens, and choosing channels is
[Connect Slack](../get-started/connect-slack.md). What each control, status, and outcome on the
dashboard means, including what **Disconnect** deletes, is [Inbound](../dashboard/inbound.md).

## What reaches Slack, and what does not

Slack gets what a responder needs to act. The dashboard gets everything.

| Posted to Slack | Kept to the dashboard |
| --- | --- |
| Human replies | The engine's step-by-step narration |
| Findings and conclusions | Individual evidence lookups |
| Recommended actions and their decisions | Cases where the platform decided to stay silent |
| Status changes | Routine provider observations |
| Recovery conclusions | Relationship and cohort decisions |
| Lifecycle updates on every thread in a causal response group | Intermediate recovery checks |

Any inconclusive finding posts as **Unverified**, followed by its next step and, when the evidence
review named them, up to three open checks under **Still to verify**. This covers a finding the
engine left inconclusive, one the evidence review rejected, and one whose review did not complete. It
is not a conclusion; the dashboard shows up to five open checks.

This split exists so that an incident channel stays readable. If you want the full audit trail, open
the incident on the dashboard.

## Replying, mentioning, and approving

**Reply in the thread** and the investigation continues from where it left off.

**Mention the bot** in a subscribed channel to pull it into something it has not already picked up.
Mentioning it in an existing incident thread adds to that incident rather than opening a new one.
Mentioning it in a ticket's thread can promote that ticket; see
[Ticket controls](../dashboard/signals.md#ticket-controls-any-member).

**Approve or deny** a recommended action using the buttons on the message. The first decision wins,
and it is recorded with who made it and when. Clicking a button on a stale message is rejected rather
than applied to a changed incident.

Approving does not run anything. The platform never executes the command or touches your
infrastructure; a human does that. See
[Steering the investigation](../understand/triage.md#steering-the-investigation).

## Delivery and reliability

Outbound messages go through a durable queue, so a Slack outage delays posts rather than losing them.
Each message is delivered by exactly one worker, and delivery is retried until it succeeds or is
explicitly abandoned.

If Slack rejects the platform's credentials, delivery stops rather than retrying forever against a
token that will never work. Reconnect the surface to resume.

Messages the platform sends are always threaded under an incident. It never posts a bare message into
a channel, which is also why it cannot get into a loop responding to itself.

A new provider episode or Slack source root always starts its own incident thread. Recurrence and
arrival-time proximity never redirect responders to an older thread. Findings and replies remain in
that incident's current thread. When evidence links several incidents into a causal response group,
lifecycle updates may also reach each status-only source thread. Relationship decisions themselves
remain on the dashboard, and every Slack destination keeps a separate delivery receipt.
