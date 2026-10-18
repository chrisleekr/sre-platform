import { expect, test } from 'vitest';
import { makeSlackPoster } from '../index';
import { createFixture } from './slack.fixture';

const fixture = createFixture();

test('renders a missing-capability finding as a blocker that names the missing data', async () => {
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
        gaps: ['Container logs for checkout-api.', 'Node kernel log.'],
      },
    }),
    'https://app.example.com/incidents/i1',
  );
  expect(calls[0]!.body.text).toBe(
    [
      '🤖 Blocked: Kubernetes logs are unavailable for this workload.',
      'Do: Grant workload log access or inspect the logs manually.',
      'Verify: Container logs for checkout-api. · Node kernel log.',
      'Incident: <https://app.example.com/incidents/i1|Open incident>',
    ].join('\n'),
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
      'Do: Query container RSS against the &lt;limit&gt; &amp; compare.',
      'Verify: Check &lt;!channel&gt; restarts. · Second. · Third.',
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
  expect(calls[0]!.body.text).toBe('🤖 Unverified: Grafana was OOMKilled.\nDo: Check RSS.');
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
      'Do: Check RSS. Incident: https://x',
      'Verify: Check restarts. Incident: https://x',
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

test('an unverified finding reads its cause as likely and a trusted one as the cause', async () => {
  const { fetch, calls } = fixture.fakeFetch({ ok: true, ts: '1' });
  const poster = makeSlackPoster(fetch);
  const finding = {
    ...inconclusive,
    likelyCause: 'The memory limit is too low.',
    impact: 'Dashboards are unavailable.',
    nextStep: 'Raise the limit to 2Gi.',
  };
  await poster.post(
    { token: 'B', channel: 'C' },
    'ROOT',
    fixture.msg({ kind: 'finding', content: 'Grafana down.', summary: 'Grafana down.', finding }),
  );
  await poster.post(
    { token: 'B', channel: 'C' },
    'ROOT',
    fixture.msg({
      kind: 'finding',
      content: 'Grafana down.',
      summary: 'Grafana down.',
      finding: {
        ...finding,
        outcome: 'conclusive',
        promotion: 'trusted_assessment',
        promotionReason: 'conclusive_assessment',
      },
    }),
  );
  expect(calls[0]!.body.text).toBe(
    [
      '🤖 Unverified: Grafana down.',
      'Likely cause: The memory limit is too low.',
      'Impact: Dashboards are unavailable.',
      'Do: Raise the limit to 2Gi.',
    ].join('\n'),
  );
  expect(calls[1]!.body.text).toBe(
    [
      '🤖 Conclusion: Grafana down.',
      'Cause: The memory limit is too low.',
      'Impact: Dashboards are unavailable.',
      'Do: Raise the limit to 2Gi.',
    ].join('\n'),
  );
});

const sha = '3391576ad9e41f223355bf10d612178f196e1a4e';
const commitUrl = `https://gitlab.example.com/group/app/-/commit/${sha}`;
const argoUrl = 'https://argocd.example.com/applications/argocd/trading-bot';

test('links the first mention of each provider entity and lists only unmentioned non-commit links', async () => {
  const { fetch, calls } = fixture.fakeFetch({ ok: true, ts: '1' });
  await makeSlackPoster(fetch).post(
    { token: 'B', channel: 'C' },
    'ROOT',
    fixture.msg({
      kind: 'finding',
      content: 'x',
      summary: 'Deploy blocked.',
      finding: {
        ...inconclusive,
        likelyCause: 'Commits 8759f2b6..3391576 re-added old bytes; 3391576a is the suspect.',
        nextStep: 'Revert, then re-sync.',
        links: [
          { label: '3391576a', url: commitUrl },
          {
            label: '40f1a393',
            url: 'https://gitlab.example.com/group/app/-/commit/40f1a3930000000000000000000000000000000a',
          },
          { label: 'trading-bot', url: argoUrl },
          { label: 'other-app', url: 'http://argocd.internal/applications/argocd/other-app' },
        ],
      },
    }),
  );
  expect(calls[0]!.body.text).toBe(
    [
      '🤖 Unverified: Deploy blocked.',
      `Likely cause: Commits 8759f2b6..<${commitUrl}|3391576> re-added old bytes; 3391576a is the suspect.`,
      'Do: Revert, then re-sync.',
      `Links: <${argoUrl}|trading-bot>`,
    ].join('\n'),
  );
});

test('a different commit sharing the first seven characters is not linked', async () => {
  const { fetch, calls } = fixture.fakeFetch({ ok: true, ts: '1' });
  await makeSlackPoster(fetch).post(
    { token: 'B', channel: 'C' },
    'ROOT',
    fixture.msg({
      kind: 'finding',
      content: 'x',
      summary: 'Commit 3391576b is unrelated; see /commit/3391576a and trading-bot-migrate.',
      finding: {
        ...inconclusive,
        nextStep: null,
        links: [
          { label: '3391576a', url: commitUrl },
          { label: 'trading-bot', url: argoUrl },
        ],
      },
    }),
  );
  expect(calls[0]!.body.text).toBe(
    [
      '🤖 Unverified: Commit 3391576b is unrelated; see /commit/3391576a and trading-bot-migrate.',
      `Links: <${argoUrl}|trading-bot>`,
    ].join('\n'),
  );
});

test('a later mention of the commit links when an earlier SHA shares its prefix', async () => {
  const { fetch, calls } = fixture.fakeFetch({ ok: true, ts: '1' });
  await makeSlackPoster(fetch).post(
    { token: 'B', channel: 'C' },
    'ROOT',
    fixture.msg({
      kind: 'finding',
      content: 'x',
      summary: 'Commit 3391576b is unrelated; 3391576a is the suspect.',
      finding: { ...inconclusive, nextStep: null, links: [{ label: '3391576a', url: commitUrl }] },
    }),
  );
  expect(calls[0]!.body.text).toBe(
    `🤖 Unverified: Commit 3391576b is unrelated; <${commitUrl}|3391576a> is the suspect.`,
  );
});

test('a section boundary never splits the incident link on an approval post', async () => {
  const { fetch, calls } = fixture.fakeFetch({ ok: true, ts: '1' });
  const incidentUrl = 'https://app.example.com/incidents/i1';
  await makeSlackPoster(fetch).post(
    { token: 'B', channel: 'C' },
    'ROOT',
    fixture.msg({
      kind: 'approval',
      // The link starts a few characters before the 3000-character section limit.
      content: 'a '.repeat(1490),
      approval: { id: 'ap1', options: [{ id: 'yes', label: 'Approve' }] },
    }),
    incidentUrl,
  );
  const sections = (calls[0]!.body.blocks as Array<{ type: string; text?: { text: string } }>)
    .filter((block) => block.type === 'section')
    .map((block) => block.text!.text);
  expect(sections.length).toBeGreaterThan(1);
  expect(sections.some((section) => section.includes(`<${incidentUrl}|Open incident>`))).toBe(true);
  for (const section of sections) expect(section.split('<').length).toBe(section.split('>').length);
});
