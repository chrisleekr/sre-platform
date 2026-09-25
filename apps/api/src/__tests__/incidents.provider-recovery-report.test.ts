import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  applySignalObservation,
  createIncident,
  PROVIDER_RECOVERY_REPORT_DECISION,
  PROVIDER_RECOVERY_REPORT_ROOT_DECISION,
  recordSignalDisposition,
} from '@sre/db';
import { createFixture } from './incidents.fixture';

const fixture = createFixture();

test('workspace lists linked Slack recovery reports and asks the operator to confirm', async () => {
  const incident = await createIncident(fixture.app.db, fixture.tenantC, {
    fingerprint: randomUUID(),
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev3',
    investigationStatus: 'degraded',
  });
  const observed = await applySignalObservation(fixture.app.db, fixture.tenantC, {
    incidentId: incident.id,
    surface: 'slack',
    channel: 'C-RECOVERY',
    externalMessageId: `root-${randomUUID()}`,
    state: 'unknown',
    summary: 'Checkout error rate is high.',
    contentHash: 'recovery-report-content',
    eventKey: `slack:C-RECOVERY:${randomUUID()}:producer:bot:B1`,
    eventAt: new Date('2026-09-20T00:00:00.000Z'),
  });
  const reportedAt = new Date('2026-09-20T00:05:00.000Z');
  await recordSignalDisposition(fixture.app.db, fixture.tenantC, {
    source: 'slack-provider',
    sourceEventKey: `slack:C-RECOVERY:${randomUUID()}:producer:bot:B1`,
    sourceEventAt: reportedAt,
    signalKey: `slack:monitor-${randomUUID()}`,
    surface: 'slack',
    channel: 'C-RECOVERY',
    threadId: 'resolved-message',
    summary: 'RESOLVED: Checkout error rate is high.',
    reason: 'Provider reported recovery in Slack; an operator confirms resolution.',
    disposition: 'log',
    effectiveDisposition: 'log',
    correlationDecision: 'recovery_reported',
    correlatedIncidentId: incident.id,
    correlatedSignalId: observed.signal.id,
  });

  const response = await fixture.api.request(
    `/incidents/${incident.id}/workspace`,
    fixture.auth(await fixture.sign(fixture.orgC)),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    providerRecoveryReports: [
      { signalId: observed.signal.id, reportedAt: reportedAt.toISOString() },
    ],
    attention: { decision: 'Provider reported recovery in Slack. Confirm resolution.' },
  });
});

test.each([
  {
    name: 'from an edit covers every alert of its grouped Slack message',
    decision: PROVIDER_RECOVERY_REPORT_ROOT_DECISION,
    otherRoot: false,
    confirm: true,
  },
  {
    name: 'from an edit does not cover an alert from a different Slack message',
    decision: PROVIDER_RECOVERY_REPORT_ROOT_DECISION,
    otherRoot: true,
    confirm: false,
  },
  {
    name: 'from a new message covers only the alert it matched',
    decision: PROVIDER_RECOVERY_REPORT_DECISION,
    otherRoot: false,
    confirm: false,
  },
])('a grouped recovery report $name', async ({ decision, otherRoot, confirm }) => {
  const incident = await createIncident(fixture.app.db, fixture.tenantC, {
    fingerprint: randomUUID(),
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev3',
    investigationStatus: 'degraded',
  });
  const root = `grouped-${randomUUID()}`;
  const observe = (externalMessageId: string) =>
    applySignalObservation(fixture.app.db, fixture.tenantC, {
      incidentId: incident.id,
      surface: 'slack',
      channel: 'C-RECOVERY',
      externalMessageId,
      state: 'unknown',
      summary: 'Checkout error rate is high.',
      contentHash: `content-${externalMessageId}`,
      eventKey: `slack:C-RECOVERY:${externalMessageId}:producer:bot:B1`,
      eventAt: new Date('2026-09-20T00:00:00.000Z'),
    });
  const first = await observe(`${root}#alert-a`);
  const second = await observe(otherRoot ? `other-${randomUUID()}#alert-b` : `${root}#alert-b`);
  const reportedAt = new Date('2026-09-20T00:05:00.000Z');
  await recordSignalDisposition(fixture.app.db, fixture.tenantC, {
    source: 'slack-provider',
    sourceEventKey: `slack:C-RECOVERY:${randomUUID()}:producer:bot:B1`,
    sourceEventAt: reportedAt,
    signalKey: `slack:monitor-${randomUUID()}`,
    surface: 'slack',
    channel: 'C-RECOVERY',
    threadId: 'resolved-message',
    summary: 'RESOLVED: Checkout error rate is high.',
    reason: 'Provider reported recovery in Slack; an operator confirms resolution.',
    disposition: 'log',
    effectiveDisposition: 'log',
    correlationDecision: decision,
    correlatedIncidentId: incident.id,
    correlatedSignalId: first.signal.id,
  });

  const response = await fixture.api.request(
    `/incidents/${incident.id}/workspace`,
    fixture.auth(await fixture.sign(fixture.orgC)),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    providerRecoveryReports: Array<{ signalId: string }>;
    attention: { decision: string } | null;
  };
  const reported = body.providerRecoveryReports.map((report) => report.signalId);
  expect(reported).toContain(first.signal.id);
  expect(reported.includes(second.signal.id)).toBe(confirm);
  expect(
    body.attention?.decision === 'Provider reported recovery in Slack. Confirm resolution.',
  ).toBe(confirm);
});
