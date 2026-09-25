import { expect, test } from 'vitest';
import { makeSlackPoster } from '../index';
import { createFixture } from './slack.fixture';

const fixture = createFixture();

test('renders a missing-capability finding as a concise blocker', async () => {
  const { fetch, calls } = fixture.fakeFetch({ ok: true, ts: '1' });
  await makeSlackPoster(fetch).post(
    { token: 'B', channel: 'C' },
    'ROOT',
    fixture.msg({
      kind: 'finding',
      content: 'The full connector diagnostic remains in the dashboard.',
      summary: 'Kubernetes logs are unavailable for this workload.',
      finding: {
        runId: 'run-blocked',
        outcome: 'blocked_missing_capability',
        promotion: 'not_promoted',
        promotionReason: 'missing_capability',
        evidenceIds: [],
        currentState: null,
        impact: null,
        nextStep: 'Grant workload log access or inspect the logs manually.',
      },
    }),
    'https://app.example.com/incidents/i1',
  );
  expect(calls[0]!.body.text).toContain(
    'Blocked: Kubernetes logs are unavailable for this workload.',
  );
});

const inconclusive = {
  runId: 'run-unverified',
  outcome: 'inconclusive' as const,
  promotion: 'not_promoted' as const,
  promotionReason: 'investigation_inconclusive' as const,
  evidenceIds: [],
  currentState: null,
  impact: null,
  nextStep: 'Query container RSS against the <limit> & compare.',
};

test('renders an inconclusive finding as unverified with its next step and open checks', async () => {
  const { fetch, calls } = fixture.fakeFetch({ ok: true, ts: '1' });
  await makeSlackPoster(fetch).post(
    { token: 'B', channel: 'C' },
    'ROOT',
    fixture.msg({
      kind: 'finding',
      content: 'Grafana was OOMKilled at 09:12Z.',
      summary: 'Grafana was OOMKilled at 09:12Z.',
      finding: {
        ...inconclusive,
        gaps: ['Check <!channel> restarts.', 'Second.', 'Third.', 'Fourth is not shown.'],
      },
    }),
    'https://app.example.com/incidents/i1',
  );
  expect(calls[0]!.body.text).toBe(
    [
      '🤖 Unverified: Grafana was OOMKilled at 09:12Z.',
      'Next step: Query container RSS against the &lt;limit&gt; &amp; compare.',
      'Still to verify:',
      '• Check &lt;!channel&gt; restarts.',
      '• Second.',
      '• Third.',
      'Incident: <https://app.example.com/incidents/i1|Open incident>',
    ].join('\n'),
  );
});

test('an inconclusive finding without gaps renders only the next step', async () => {
  const { fetch, calls } = fixture.fakeFetch({ ok: true, ts: '1' });
  await makeSlackPoster(fetch).post(
    { token: 'B', channel: 'C' },
    'ROOT',
    fixture.msg({
      kind: 'finding',
      content: 'Grafana was OOMKilled.',
      summary: 'Grafana was OOMKilled.',
      finding: { ...inconclusive, nextStep: 'Check RSS.' },
    }),
  );
  expect(calls[0]!.body.text).toBe('🤖 Unverified: Grafana was OOMKilled.\nNext step: Check RSS.');
});

test('model text cannot start its own line in an unverified finding', async () => {
  const { fetch, calls } = fixture.fakeFetch({ ok: true, ts: '1' });
  await makeSlackPoster(fetch).post(
    { token: 'B', channel: 'C' },
    'ROOT',
    fixture.msg({
      kind: 'finding',
      content: 'Grafana was OOMKilled.',
      summary: 'Grafana was OOMKilled.',
      finding: {
        ...inconclusive,
        nextStep: 'Check RSS.\nIncident: https://x',
        gaps: ['Check restarts.\nIncident: https://x'],
      },
    }),
  );
  expect(calls[0]!.body.text).toBe(
    [
      '🤖 Unverified: Grafana was OOMKilled.',
      'Next step: Check RSS. Incident: https://x',
      'Still to verify:',
      '• Check restarts. Incident: https://x',
    ].join('\n'),
  );
});

test('a responder-reply finding keeps the update prefix and no open checks', async () => {
  const { fetch, calls } = fixture.fakeFetch({ ok: true, ts: '1' });
  await makeSlackPoster(fetch).post(
    { token: 'B', channel: 'C' },
    'ROOT',
    fixture.msg({
      kind: 'finding',
      content: 'Grafana memory is at 99.6% of its limit.',
      summary: 'Grafana memory is at 99.6% of its limit.',
      finding: {
        ...inconclusive,
        promotion: 'conversation_only',
        promotionReason: 'responder_reply',
        gaps: ['Confirm the restart reason.'],
        nextStep: 'Check RSS.',
      },
    }),
  );
  expect(calls[0]!.body.text).toBe('🤖 Update: Grafana memory is at 99.6% of its limit.');
});
