# Reliability

The Reliability workspace compares the selected UTC calendar period with the immediately preceding period. Week, month, and quarter use calendar boundaries rather than rolling windows.

**Signals per incident** is terminal classified signal records divided by Incidents opened in that UTC
period. Per-service rows show both numerators and the nullable ratio using the same definitions. Top
causes count distinct Incidents carrying a human-applied `cause:*` tag. Those counts depend on
monitoring sensitivity and do not represent severity or repair difficulty.

Current and previous comparisons use the same elapsed period-to-date duration. The UI shows both
UTC ranges. Signal ratios are `N/A` when the requested range starts before retained signal coverage;
this includes pre-measurement history and periods longer than the tenant's retention window.

Ticket flow reports the cohort created in the selected UTC period: promotion rate, creation-to-promotion time, and the current age of tickets that remain open. These definitions appear beside the values.

Toil created and toil removed are shown together. The product reports durable proxies, not unobservable external work:

- created: approval demands, typed clarification requests, degraded exact re-asks, and finding corrections;
- removed: creation-to-first-ranked-hypothesis latency, responder turns per provider Incident, cited `search_runbooks` evidence adoption, and provider Incidents resolved without responder turns or approved actions. This last measure counts operational resolution under the recorded policy, including authoritative provider clearance. It does not measure independently verified service health.

Select **Weekly report** from the Reliability workspace to render the same weekly DTO in report mode. It does not run a second analytics computation.

## Postmortem action items

This section reports the postmortems of the current workspace only: how many are drafts and how many
are published, then the state of their action items.

- **Open items by age** counts items whose state is open or in progress, bucketed by time since the
  item was created: under 7 days, 7 to 30 days, and over 30 days. Age is measured from the item, not
  from the incident.
- **Untracked** counts open items with no owner or no tracker link. Generated items start untracked
  by construction, so this number is non-zero until a person fills them in. That is the point: an
  untracked action item is a defect the report shows, not a detail it hides.
- **Past due** counts open items whose due date has passed, and lists the postmortems carrying them
  with a link to each.

Done and will not do are terminal states; an item in either is neither open nor past due.

## RCA calibration

Every automated root-cause assessment claims a confidence. This section answers one question: does
that number predict being right? Grades come from two sources. Confirming or correcting a finding in
the incident workspace records a human verdict for the assessment run that produced it. Publishing a
postmortem queues the model judge, which grades the run's summary and top hypothesis against the
published contributing causes. When both exist the human verdict is the one reported, and the judge's
verdict is kept so the judge can be scored: **judge agreement** is the share of runs graded by both
where the two verdicts match.

The section reports overall accuracy, accuracy by claimed-confidence bucket (below 50, 50 to 79, and
80 and above), accuracy for runs that cited a runbook against runs that did not, and judge agreement.
Accuracy is the share of graded runs whose verdict is correct; partial counts as not correct.

**Reporting floor.** An accuracy is reported only from 10 graded runs. Below that the value is shown
as insufficient data in prose, never as a rounded number and never as an empty chart. The verdict on
the whole curve follows the same rule: it is insufficient data until both the lowest and the highest
confidence bucket reach the floor; then it is informative when the highest bucket's accuracy beats
the lowest bucket's by at least 15 points, and uninformative when it does not. Uninformative means
the score is noise, and the page says so.

The confidence a grade records is the one the run claimed at the time, snapshotted with the grade.
A later re-assessment of the same incident does not move it, so an old grade can never be attributed
to a new number. Calibration is measured, never applied: nothing on this page rescales a confidence.
