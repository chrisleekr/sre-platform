# Signals

Review actionable tickets and retained context without starting an investigation. What the three
dispositions mean, and how shadow mode differs from enforcement, is explained in
[Signal control](../understand/signal-control.md); this page describes the screen.

## Status rail

Three figures sit above the queue:

| Shows | Means |
| --- | --- |
| **Visible in queue** | How many signals are loaded on the current tab. |
| **Ticket promotion** | Promoted tickets divided by operational tickets, as a percentage. With no tickets it reads `N/A`, not a false zero. Only enforced tickets count; shadow proposals are excluded. |
| **Effective routing** | `shadow` or `enforce`: the mode actually routing traffic right now, together with the retention period. |

## Signal disposition tabs

| Tab | Lists |
| --- | --- |
| **Tickets** | **Tickets needing review**: deferred reliability risks, until reviewed or promoted. |
| **Investigations** | **Investigation routes**: signals routed to incident investigation, kept for audit. |
| **Logged context** | Low-risk observations kept for later correlation. |

Each list pages with **Load more**.

## Signal cards

Every card shows the summary, when it arrived, and the classifier's reason.

Under shadow mode the card is labelled **Shadow proposal:** followed by the proposed disposition,
with a second line, **Effective route:** followed by what actually happened (or `pending`). Shadow
proposals do not enter operational ticket or log metrics.

A ticket card also shows:

| Field | Means |
| --- | --- |
| **Action** | The concrete thing to do. |
| **Safe to defer** | Why it does not need incident response right now. |
| **Risk if ignored** | What happens if nobody acts. |
| **Review within N minutes.** | The review horizon. |

### Ticket controls (any member)

| Control | Does |
| --- | --- |
| **Start review** | Marks the ticket as under review. Once the review horizon passes, the platform may post one reminder in the ticket's Slack thread. It never promotes the ticket. |
| **Declaration criterion** and **Investigate** | Pick a criterion (**Needs a second team**, **Customer-visible**, **Unsolved after review**, **Other**), enter why this now needs incident response, and click **Investigate**. The ticket becomes an incident through the same path an alert takes, and the member, surface, criterion, and reason are recorded. **Unsolved after review** appears only after review has been running longer than the configured unsolved review time. |

Replying to the ticket's Slack thread with a mention of the bot and `investigate` (or `promote`) does
the same thing. Promotion never happens automatically.

## Routing and tag settings

The collapsible **Routing and tag settings** card at the bottom holds the platform-administrator
controls. Everyone can see them; the platform refuses the change for anyone who is not a platform
administrator.

### Signal control settings

| Control | Does |
| --- | --- |
| **Retention days** | How long signal records are kept before the maintenance sweep expires them. |
| **Unsolved review minutes** | How long a ticket must have been under review before **Unsolved after review** becomes an available criterion. |
| **Second-team criterion**, **Customer-visible criterion** | Whether **Needs a second team** and **Customer-visible** are offered as declaration criteria when promoting a ticket. |
| **Save settings** | Saves the values above. Changing any input that enforcement was approved against leaves effective routing in shadow mode. |

### Classifier evaluation

| Control | Does |
| --- | --- |
| **Run accuracy evaluation** | Runs the reviewed corpus through the currently configured, metered model. The card polls until the run finishes and then shows **Classifier accuracy by disposition** and each **Scenario:** beside its **Reviewed reference** and **Runtime prediction**. |
| **Approve enforcement** | Enabled only when the latest evaluation is complete with every scenario correct, zero critical-safety misses, and a corpus and contract that match the current runtime, and after you have checked every free-form ticket result against its reference. Otherwise the card says **Cannot enforce:** with the reason. |
| **Return to shadow** | Shown while enforcement is on. Puts routing back in shadow mode immediately. |

If enforcement was approved but the model runtime or classifier contract has since changed, the card
says **Enforcement approval is stale for the current runtime or classifier contract. Routing remains
in shadow mode.** until a new evaluation is approved.

What a signal record holds, and how retention works, is explained under
[What is retained](../understand/signal-control.md#what-is-retained).
