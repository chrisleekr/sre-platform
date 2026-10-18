import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  applySignalObservation,
  createIncident,
  incidentMessages,
  incidentSignals,
  incidents,
  jobs,
  listProviderRecoveryReports,
} from '@sre/db';
import type { InboundCandidate } from '@sre/connectors';
import {
  CHANNEL,
  PRODUCER,
  VERIFYING,
  admin,
  app,
  disposition,
  handler,
  intakeReceipt,
  job,
  recoveryJobs,
  reportMessages,
  resolvedCandidate,
  signalStates,
  tenantId,
  trackedIncident,
  useRecoveryFixture,
} from './recovery-report.fixture';

useRecoveryFixture();

describe('Slack recovery verification', () => {
  test('behind the production fence, an Alertmanager edit to resolved still queues verification', async () => {
    const tracked = await trackedIncident(`slack:monitor-${randomUUID()}`);
    const { handle, onOutcome } = handler(true, true);
    const edit = resolvedCandidate('unused', {
      externalId: tracked.root,
      eventKey: `slack:${CHANNEL}:${tracked.root}:edit:2:producer:${PRODUCER}`,
      isEdit: true,
      observations: undefined,
    });
    const candidate = { ...edit, intakeId: await intakeReceipt(edit) };

    await handle(job(candidate));

    // Linking records this event as decided, so a second fenced pass would supersede itself.
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'resolution_reported' }),
    );
    expect(await reportMessages(tracked.incidentId)).toEqual([
      { author: 'system', content: VERIFYING },
    ]);
    expect(await recoveryJobs(tracked.incidentId)).toHaveLength(1);
    expect(await signalStates(tracked.incidentId)).toEqual([
      { state: 'resolved', clearProvenance: 'unknown' },
    ]);
  });

  test('a notice covering every active alert resolves it and queues recovery verification once', async () => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const tracked = await trackedIncident(monitorKey);
    const { handle, onOutcome, route } = handler();
    const candidate = resolvedCandidate(monitorKey);

    await handle(job(candidate));
    await handle(job(candidate));

    expect(route).not.toHaveBeenCalled();
    // The redelivery still links, although the first delivery already resolved the signal.
    expect(onOutcome.mock.calls.map(([event]) => event.outcome)).toEqual([
      'resolution_reported',
      'resolution_reported',
    ]);
    expect(await reportMessages(tracked.incidentId)).toEqual([
      { author: 'system', content: VERIFYING },
    ]);
    expect(await disposition(candidate.eventKey)).toEqual([
      expect.objectContaining({
        disposition: 'log',
        correlationDecision: 'recovery_reported',
        correlatedIncidentId: tracked.incidentId,
        correlatedSignalId: tracked.signalId,
      }),
    ]);
    // Slack text is not provider proof, so the clear is recorded without provider provenance.
    expect(await signalStates(tracked.incidentId)).toEqual([
      { state: 'resolved', clearProvenance: 'unknown' },
    ]);
    expect(await recoveryJobs(tracked.incidentId)).toHaveLength(1);
    // Only verification resolves the incident.
    const [incident] = await admin.db
      .select({ status: incidents.status })
      .from(incidents)
      .where(eq(incidents.id, tracked.incidentId));
    expect(incident!.status).toBe('open');
  });

  test('a later notice on an already cleared incident leaves a scheduled recheck alone', async () => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const tracked = await trackedIncident(monitorKey);
    const { handle } = handler();
    await handle(job(resolvedCandidate(monitorKey)));
    // A monitoring cycle schedules its next check ahead.
    const scheduled = new Date(Date.now() + 60 * 60 * 1000);
    await admin.db
      .update(jobs)
      .set({ availableAt: scheduled })
      .where(
        and(
          eq(jobs.type, 'recovery.verify'),
          sql`${jobs.payload} ->> 'incidentId' = ${tracked.incidentId}`,
        ),
      );

    const later = resolvedCandidate(monitorKey);
    await handle(job(later));

    const rows = await admin.db
      .select({ availableAt: jobs.availableAt, status: jobs.status })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, 'recovery.verify'),
          sql`${jobs.payload} ->> 'incidentId' = ${tracked.incidentId}`,
        ),
      );
    expect(rows).toEqual([{ availableAt: scheduled, status: 'queued' }]);
    // The check is still pending, so the notice reads as verifying rather than refused.
    expect(await reportMessages(tracked.incidentId)).toEqual([
      { author: 'system', content: VERIFYING },
      { author: 'system', content: VERIFYING },
    ]);
  });

  test('one notice covers every earlier post of the same monitor', async () => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const first = await trackedIncident(monitorKey);
    // A provider that re-posts while firing leaves a second signal for the same monitor.
    const repostRoot = `root-${randomUUID()}`;
    await applySignalObservation(app.db, tenantId, {
      incidentId: first.incidentId,
      surface: 'slack',
      channel: CHANNEL,
      externalMessageId: repostRoot,
      state: 'unknown',
      summary: 'Checkout error rate is high.',
      contentHash: 'repost',
      monitorKey,
      eventKey: `slack:${CHANNEL}:${repostRoot}:producer:${PRODUCER}`,
      eventAt: new Date('2026-09-20T00:01:00.000Z'),
    });
    const { handle } = handler();

    await handle(job(resolvedCandidate(monitorKey)));

    expect((await signalStates(first.incidentId)).map((signal) => signal.state)).toEqual([
      'resolved',
      'resolved',
    ]);
    expect(await recoveryJobs(first.incidentId)).toHaveLength(1);
  });

  test('a firing edit older than the notice that resolved the alert does not reopen it', async () => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const tracked = await trackedIncident(monitorKey);
    const { handle } = handler();
    await handle(job(resolvedCandidate(monitorKey)));
    // Delivered late: the alert message was edited to firing at 00:03, before the 00:05 notice.
    const eventAt = '2026-09-20T00:03:00.000Z';
    const version = String(Date.parse(eventAt) * 1000);
    const eventKey = `slack:${CHANNEL}:${tracked.root}:edit:${version}:producer:${PRODUCER}`;
    const text = '[FIRING:1] Checkout error rate is high.';

    await handle(
      job(
        resolvedCandidate(monitorKey, {
          externalId: tracked.root,
          eventKey,
          eventAt,
          eventVersion: version,
          isEdit: true,
          text,
          signalState: 'firing',
          contentHash: createHash('sha256').update(text).digest('hex'),
          observations: [
            {
              externalMessageId: tracked.root,
              state: 'unknown',
              summary: text,
              contentHash: 'late-edit',
              eventKey,
              eventAt,
              monitorKey,
            },
          ],
        }),
      ),
    );

    expect(await signalStates(tracked.incidentId)).toEqual([
      { state: 'resolved', clearProvenance: 'unknown' },
    ]);
    expect((await recoveryJobs(tracked.incidentId)).map((row) => row.status)).toEqual(['queued']);
  });

  test('a notice does not cover a post of the same monitor from another bot', async () => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const first = await trackedIncident(monitorKey);
    // The monitor key hashes channel, provider and alert name, so another bot can share it.
    const otherRoot = `root-${randomUUID()}`;
    await applySignalObservation(app.db, tenantId, {
      incidentId: first.incidentId,
      surface: 'slack',
      channel: CHANNEL,
      externalMessageId: otherRoot,
      state: 'unknown',
      summary: 'Checkout error rate is high.',
      contentHash: 'other-bot',
      monitorKey,
      eventKey: `slack:${CHANNEL}:${otherRoot}:producer:bot:B_OTHER`,
      eventAt: new Date('2026-09-20T00:01:00.000Z'),
    });
    const { handle } = handler();

    await handle(job(resolvedCandidate(monitorKey)));

    expect((await signalStates(first.incidentId)).map((signal) => signal.state)).toEqual([
      'unknown',
      'unknown',
    ]);
    expect(await recoveryJobs(first.incidentId)).toEqual([]);
  });

  test('an edit to resolved covers earlier episodes of the same monitor posted as new messages', async () => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const first = await trackedIncident(monitorKey);
    // Each episode is a new Slack message; the earlier one never settled.
    const laterRoot = `root-${randomUUID()}`;
    await applySignalObservation(app.db, tenantId, {
      incidentId: first.incidentId,
      surface: 'slack',
      channel: CHANNEL,
      externalMessageId: laterRoot,
      state: 'unknown',
      summary: 'Checkout error rate is high.',
      contentHash: 'later-episode',
      monitorKey,
      eventKey: `slack:${CHANNEL}:${laterRoot}:producer:${PRODUCER}`,
      eventAt: new Date('2026-09-20T00:01:00.000Z'),
    });
    const { handle } = handler();

    await handle(
      job(
        resolvedCandidate(monitorKey, {
          externalId: laterRoot,
          eventKey: `slack:${CHANNEL}:${laterRoot}:edit:2:producer:${PRODUCER}`,
          isEdit: true,
          observations: undefined,
        }),
      ),
    );

    expect((await signalStates(first.incidentId)).map((signal) => signal.state)).toEqual([
      'resolved',
      'resolved',
    ]);
    expect(await recoveryJobs(first.incidentId)).toHaveLength(1);
  });

  test('a notice covering one of two active alerts stays advisory', async () => {
    const tracked = await trackedIncident(`slack:monitor-${randomUUID()}`);
    const otherRoot = `root-${randomUUID()}`;
    await applySignalObservation(app.db, tenantId, {
      incidentId: tracked.incidentId,
      surface: 'slack',
      channel: CHANNEL,
      externalMessageId: otherRoot,
      state: 'unknown',
      summary: 'Checkout latency is high.',
      contentHash: 'firing-other',
      monitorKey: `slack:monitor-${randomUUID()}`,
      eventKey: `slack:${CHANNEL}:${otherRoot}:producer:${PRODUCER}`,
      eventAt: new Date('2026-09-20T00:00:00.000Z'),
    });
    const { handle } = handler();
    const candidate = resolvedCandidate('unused', {
      externalId: tracked.root,
      eventKey: `slack:${CHANNEL}:${tracked.root}:edit:2:producer:${PRODUCER}`,
      isEdit: true,
      observations: undefined,
    });

    await handle(job(candidate));

    expect(await reportMessages(tracked.incidentId)).toEqual([
      {
        author: 'system',
        content:
          'Provider reported recovery in Slack at 2026-09-20T00:05:00.000Z. Verification starts when every active alert on this incident has reported recovery.',
      },
    ]);
    expect((await signalStates(tracked.incidentId)).map((signal) => signal.state)).toEqual([
      'unknown',
      'unknown',
    ]);
    expect(await recoveryJobs(tracked.incidentId)).toEqual([]);
  });

  test('a re-fire during verification joins the same incident and adds an active signal', async () => {
    const monitorKey = `slack:monitor-${randomUUID()}`;
    const tracked = await trackedIncident(monitorKey);
    const { handle, route } = handler();
    await handle(job(resolvedCandidate(monitorKey)));
    expect(await recoveryJobs(tracked.incidentId)).toHaveLength(1);
    // Repeat matching only trusts a recently seen episode.
    await admin.db
      .update(incidentSignals)
      .set({ lastSeenAt: new Date(Date.now() - 60_000) })
      .where(eq(incidentSignals.id, tracked.signalId));

    const externalId = `refire-${randomUUID()}`;
    const eventKey = `slack:${CHANNEL}:${externalId}:producer:${PRODUCER}`;
    const text = '[FIRING:1] Checkout error rate is high.';
    await handle(
      job(
        resolvedCandidate(monitorKey, {
          externalId,
          eventKey,
          eventAt: new Date().toISOString(),
          text,
          signalState: 'firing',
          alertKind: 'firing',
          contentHash: createHash('sha256').update(text).digest('hex'),
          observations: [
            {
              externalMessageId: externalId,
              state: 'firing',
              summary: text,
              contentHash: 'refire',
              eventKey,
              eventAt: new Date().toISOString(),
              monitorKey,
            },
          ],
        }),
      ),
    );

    // The classifier double throws when called, so the repeat path attached it.
    expect(route).not.toHaveBeenCalled();
    expect((await signalStates(tracked.incidentId)).map((signal) => signal.state).sort()).toEqual([
      'resolved',
      'unknown',
    ]);
  });

  test('an Alertmanager message edited to resolved and back to firing no longer reads as recovered', async () => {
    const root = `grouped-${randomUUID()}`;
    const incident = await createIncident(app.db, tenantId, {
      fingerprint: `recovery-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    const monitors = [`slack:monitor-a-${randomUUID()}`, `slack:monitor-b-${randomUUID()}`];
    for (const [index, monitorKey] of monitors.entries())
      await applySignalObservation(app.db, tenantId, {
        incidentId: incident.id,
        surface: 'slack',
        channel: CHANNEL,
        externalMessageId: `${root}#alert-${index}`,
        state: 'unknown',
        summary: 'Checkout error rate is high.',
        contentHash: `firing-${index}`,
        monitorKey,
        eventKey: `slack:${CHANNEL}:${root}:producer:${PRODUCER}`,
        eventAt: new Date('2026-09-20T00:00:00.000Z'),
      });
    // Slack update_message edits the same message; the first alert's monitor keys supersession.
    const edit = (text: string, eventAt: string, monitorKey: string): InboundCandidate => {
      const version = String(Date.parse(eventAt) * 1000);
      const eventKey = `slack:${CHANNEL}:${root}:edit:${version}:producer:${PRODUCER}`;
      return resolvedCandidate(monitorKey, {
        externalId: root,
        eventKey,
        eventAt,
        eventVersion: version,
        isEdit: true,
        text,
        signalState: text.startsWith('[RESOLVED') ? 'resolved' : 'firing',
        contentHash: createHash('sha256').update(text).digest('hex'),
        observations: [
          {
            externalMessageId: root,
            state: 'unknown',
            summary: text,
            contentHash: 'edit',
            eventKey,
            eventAt,
            monitorKey,
          },
        ],
      });
    };
    const { handle } = handler();
    const covered = async () =>
      (await listProviderRecoveryReports(app.db, tenantId, incident.id)).length;

    await handle(
      job(
        edit('[RESOLVED] Checkout error rate is high.', '2026-09-20T00:05:00.000Z', monitors[0]!),
      ),
    );
    // The root report covered both alerts, so both resolved and verification was queued.
    expect((await signalStates(incident.id)).map((signal) => signal.state)).toEqual([
      'resolved',
      'resolved',
    ]);
    expect(await recoveryJobs(incident.id)).toHaveLength(1);

    await handle(
      job(edit('[FIRING:1] Checkout latency is high.', '2026-09-20T00:08:00.000Z', monitors[1]!)),
    );
    expect(await covered()).toBe(0);
    // A report older than the re-fire can no longer cover the reopened signals.
    const seen = await admin.db
      .select({ lastSeenAt: incidentSignals.lastSeenAt })
      .from(incidentSignals)
      .where(eq(incidentSignals.incidentId, incident.id));
    expect(seen.map((row) => row.lastSeenAt.toISOString())).toEqual([
      '2026-09-20T00:08:00.000Z',
      '2026-09-20T00:08:00.000Z',
    ]);
    // Reopening bumps the signal versions, so the queued verification's fence no longer matches.
    expect(await signalStates(incident.id)).toEqual([
      { state: 'unknown', clearProvenance: null },
      { state: 'unknown', clearProvenance: null },
    ]);
    // The queued verification is retired and the recovery projection cleared, as a repeat firing does.
    expect((await recoveryJobs(incident.id)).map((row) => row.status)).toEqual(['done']);
    const [projection] = await admin.db
      .select({ recoveryState: incidents.recoveryState, nextCheck: incidents.recoveryNextCheckAt })
      .from(incidents)
      .where(eq(incidents.id, incident.id));
    expect(projection).toEqual({ recoveryState: null, nextCheck: null });
    const [refired] = await admin.db
      .select({ content: incidentMessages.content })
      .from(incidentMessages)
      .where(
        and(
          eq(incidentMessages.incidentId, incident.id),
          sql`${incidentMessages.originMessageId} like 'slack-refired:%'`,
        ),
      );
    expect(refired!.content).toBe(
      'Alert fired again in Slack at 2026-09-20T00:08:00.000Z. Recovery is no longer reported.',
    );
  });
});
