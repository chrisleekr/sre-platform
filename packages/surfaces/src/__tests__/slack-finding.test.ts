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
