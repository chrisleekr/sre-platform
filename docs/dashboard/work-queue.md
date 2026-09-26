# Work queue

What the platform is doing in the background for your workspace, and what it gave up on.

Every investigation, follow-up, runbook, postmortem and classification runs as a job on a durable
queue. Most jobs finish without anyone noticing. This page is where you look when something seems
stuck, or when an incident shows a degraded investigation and you want to know whether it is the
only one.

The page is read-only. It never retries, edits or deletes a job.

The page does not update on its own. Select **Refresh** to reload the counts and restart the dead-job
list from the newest job.

## By type

One row per kind of job that has outstanding or failed work. Completed jobs are not counted: they say
nothing about whether the queue is healthy.

| Column | Means |
| --- | --- |
| **Queued** | Waiting for a worker, including work scheduled for later |
| **Processing** | Claimed by a worker and running now |
| **Dead** | Failed after its last allowed attempt; nothing will run it again on its own |
| **Oldest waiting** | How long the oldest job that is already due has been waiting. Work scheduled for later does not count until its time arrives |

A queued count that keeps growing while the oldest waiting time climbs means workers are not keeping
up, or are not running. A dead count above zero means some work needs a person to look at it.

Investigations run beside the other kinds of work, so a long investigation does not hold up
connector polling, classification of new messages, or runbooks. Within one kind, a worker runs one
job at a time, so several retries requested together finish one after another.

## Dead jobs

Every dead job, newest first, with **Load more** for older ones.

| Column | Means |
| --- | --- |
| **Type** | The kind of work that failed |
| **Incident** | The incident the work belonged to, linked to its page. **No incident** means the work was not tied to one, or that incident no longer exists |
| **Attempts** | How many times a worker tried it |
| **Last error** | The final error, shortened, with recognisable credentials replaced by `[REDACTED]` |
| **Failed** | When the job was given up on |

A dead job stays listed for at least a day after it fails. After that the worker removes it along
with the rest of the finished job history.

## Retrying

Retry a failed investigation from its incident page, using **Retry investigation** there. Follow the
link in the **Incident** column to get to it.

There is no bulk retry on this page, on purpose. Each retry from an incident page first checks that
the incident has not changed since you looked at it, and records who asked for the retry in the
incident conversation. A bulk action would skip both: it would re-run work against incidents that
may have moved on, with nobody named as having asked.
