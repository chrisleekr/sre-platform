# Signal control

Not every message in an alert channel deserves a page. Signal control is how the platform decides,
for each message it accepts, what work should happen, and how that decision is kept honest.

Two questions are answered separately for every material message:

- **Disposition**: what work should happen. One of **investigate**, **ticket**, or **log**.
- **Correlation**: which incident, if any, this belongs to. A message can join an existing incident,
  resolve an open alert, or stand alone.

Both are decided in one model call, on scrubbed text, with no diagnostic tool calls. Neither
decision depends on the other. The [glossary](glossary.md) defines **Disposition** and **Signal**.

## The three dispositions

| Disposition | What happens | Where you see it |
| --- | --- | --- |
| **Investigate** | An incident opens (or the message joins one) and a full investigation run is spent on it. | The incident list, its Slack thread, and the **Investigations** tab on [Signals](../dashboard/signals.md). |
| **Ticket** | A real reliability risk that is safe to defer. The platform records the concrete action, why it is safe to defer, the risk of ignoring it, and a review horizon. No investigation runs until a human promotes it. | The **Tickets** tab on Signals, and a reminder in its Slack thread when review is due. |
| **Log** | Useful operational context with no action attached. Kept for later correlation and then expired. | The **Logged context** tab on Signals. |

**Investigate is never the default.** The classifier is asked to choose ticket for a risk it cannot
call either way, including uncertain or ambiguous impact. The one exception runs the other way: if the
classifier itself fails, the message is not dropped. A model outage is retried a bounded number of
times (five attempts), and a verdict that comes back malformed, or still unavailable after those
retries, **fails open to an investigation**, marked as degraded, so an uncertain classifier can never
silently swallow a page. A recognised provider alert also always opens or joins an investigation,
whatever the classifier says; the recognised shapes are listed in
[Connect Slack](../get-started/connect-slack.md#what-counts-as-a-provider-alert).

## Shadow mode and enforcement

A new classifier does not get to route traffic on its first day. Its decisions start in **shadow
mode** and stay there until a platform administrator approves **enforcement**.

**In shadow mode** the classifier's disposition is recorded as a *proposal* but does not change what
happens. Routing follows the conservative rule that predates the classifier: a firing provider alert
opens an investigation, a recognised recovery notice or an edit is logged, and everything else is
either investigated or logged according to the correlation verdict. A ticket or log proposal that
would otherwise have dropped a message still opens an investigation. The Signals page shows each
proposal beside what actually happened, and shadow proposals do not count towards the ticket queue or
the promotion figures.

**Under enforcement** the classifier's disposition is what happens: a ticket goes to the ticket
queue, a log entry is retained, and only investigate spends an investigation run. Correlation still
wins where it applies: a message the classifier links to an existing incident, or that resolves an
open alert, follows that link regardless of its disposition.

Enforcement is approved against a specific model, endpoint, prompt contract, and reviewed test
corpus. If any of those change, the approval is stale and routing drops back to shadow mode on its
own until a new evaluation is approved; the Signals page says so when it happens.

## Who can change it

Anyone who can open the dashboard can read the current mode, review tickets, and promote a ticket to
an incident. Evaluating the classifier, approving enforcement, returning to shadow, and changing the
retention and declaration settings require a **platform administrator**; the controls are visible to
everyone, but the platform refuses the change for anyone else. Approval is offered only after a
metered evaluation of the reviewed corpus completes with every scenario correct and no
critical-safety miss, and it is stored with the approving user and time. The controls themselves are
described under [Routing and tag settings](../dashboard/signals.md#routing-and-tag-settings).

## Promoting a ticket

A ticket is promoted to an incident by a human, never automatically, either from the Signals page or
from the ticket's Slack thread. Either route opens the incident through the same path an alert would,
and records who promoted it, from which surface, under which criterion, and why. Starting review on a
ticket only lets the platform post one reminder when the review horizon passes. The controls are
described under [Ticket controls](../dashboard/signals.md#ticket-controls-any-member).

## What is retained

A signal record holds scrubbed, bounded fields: the summary and reason, the channel and thread it
came from, and its disposition. The raw provider payload is not stored there. Each tenant sets how
long records are kept, and the maintenance sweep deletes only expired records, in bounded batches.
The Inbound receipt, described in [Inbound](../dashboard/inbound.md#what-happened-to-the-last-message),
is separate and holds envelope metadata only.
