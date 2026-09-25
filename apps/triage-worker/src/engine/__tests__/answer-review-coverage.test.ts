import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { reviewInvestigation } from '../evidence-review';
import { makeFakeGenerator } from '../fake';
import type { ResumeInput, TriageResult } from '../types';

const evidenceId = randomUUID();
const input: ResumeInput = {
  incident: {
    id: randomUUID(),
    tenantId: randomUUID(),
    service: 'node',
    severity: 'sev3',
    fingerprint: 'node',
    alertSource: 'slack',
  },
  humanMessage: 'What is the conclusion of the runbook?',
  prior: [{ author: 'human', kind: 'text', content: 'Create a diagnostic guide for next time.' }],
};
const evidence = {
  id: evidenceId,
  tool: 'metrics',
  input: {},
  output: { diskBusy: 1 },
  createdAt: new Date('2026-09-11T01:00:00Z'),
  outcome: 'data',
};
const candidate: TriageResult = {
  provider: 'fake',
  sessionId: 'test',
  outcome: 'conclusive',
  turnBudget: 1,
  disposition: 'reply',
  summary: 'Restarting fixes it.',
  detail: 'Unverified remedy',
  confidence: 90,
  evidenceIds: [evidenceId],
};

test('bounded review preserves gap-free serialized source ranges and supplies all chunk notes to synthesis', async () => {
  const source = {
    ...evidence,
    output: `10:28 absent ${'x'.repeat(120_000)} 10:56 active ${'x'.repeat(120_000)}`,
  };
  const serialized = JSON.stringify(source);
  const ranges: {
    offset: number;
    endOffset: number;
    totalLength: number;
    content: string;
    evidenceId: string;
  }[] = [];
  let synthesis = false;
  const generator = makeFakeGenerator((prompt) => {
    const payload = JSON.parse(prompt);
    if (payload.evidenceSlices) {
      ranges.push(...payload.evidenceSlices);
      return {
        complete: true,
        notes: [
          {
            kind: 'observation',
            text: prompt.includes('10:56 active')
              ? 'Runner active at 10:56.'
              : prompt.includes('10:28 absent')
                ? 'Runner absent at 10:28.'
                : 'Slice alone cannot establish continuing absence.',
            evidenceIds: [evidenceId],
          },
        ],
      };
    }
    synthesis = true;
    expect(payload.reviewedEvidence).toHaveLength(ranges.length);
    expect(JSON.stringify(payload.reviewedEvidence)).toContain('Runner active at 10:56.');
    expect(JSON.stringify(payload.reviewedEvidence)).toContain('Runner absent at 10:28.');
    return {
      supported: false,
      summary: 'The runner was active at 10:56.',
      detail: 'Do not generalize absence from 10:28 to the later window.',
      reason: 'Observation windows differ.',
      evidenceIds: [evidenceId],
    };
  });
  const result = await reviewInvestigation(
    generator,
    candidate,
    [source],
    new AbortController().signal,
    input,
  );
  expect(synthesis).toBe(true);
  expect(ranges[0]?.offset).toBe(0);
  expect(ranges.at(-1)?.endOffset).toBe(serialized.length);
  expect(ranges.map((range) => range.content).join('')).toBe(serialized);
  for (const [index, range] of ranges.entries()) {
    expect(range.evidenceId).toBe(evidenceId);
    expect(range.totalLength).toBe(serialized.length);
    expect(range.endOffset - range.offset).toBe(range.content.length);
    expect(range.content.length).toBeLessThanOrEqual(80_000);
    if (index > 0) expect(range.offset).toBe(ranges[index - 1]!.endOffset);
  }
  expect(result.detail).toContain('10:28');
});

test('an invalid intermediate review stops coverage and withholds unchecked procedures', async () => {
  let calls = 0;
  const result = await reviewInvestigation(
    makeFakeGenerator(() => {
      calls++;
      if (calls === 2) return {};
      return {
        complete: true,
        notes: [
          { kind: 'uncertainty', text: 'More coverage required.', evidenceIds: [evidenceId] },
        ],
      };
    }),
    candidate,
    [{ ...evidence, output: 'x'.repeat(240_000) }],
    new AbortController().signal,
  );
  expect(calls).toBe(2);
  expect(result).toMatchObject({ outcome: 'inconclusive', confidence: 0 });
  expect(result.unknowns?.at(-1)).toMatchObject({
    category: 'partial_evidence',
    question: expect.stringMatching(/invalid/i),
  });
  expect(result.detail).not.toContain('Unverified remedy');
});

test('covers a large Kubernetes pod inventory without dropping nested status fields', async () => {
  const output = {
    kind: 'PodList',
    items: Array.from({ length: 950 }, (_, index) => ({
      metadata: { name: `runner-${index}`, namespace: 'ci', labels: { app: 'runner' } },
      spec: { nodeName: 'node-1', containers: [{ name: 'runner', image: 'runner:stable' }] },
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            ready: true,
            restartCount: index,
            state: { running: { startedAt: '2026-09-13T01:00:00Z' } },
          },
        ],
      },
    })),
  };
  const seen: string[] = [];
  const result = await reviewInvestigation(
    makeFakeGenerator((prompt) => {
      const payload = JSON.parse(prompt);
      if (payload.evidenceSlices) {
        const content = payload.evidenceSlices
          .map((slice: { content: string }) => slice.content)
          .join('');
        seen.push(...payload.evidenceSlices.map((slice: { content: string }) => slice.content));
        const restartCounts = [...content.matchAll(/"restartCount":(\d+)/g)].map((match) =>
          Number(match[1]),
        );
        return {
          complete: true,
          notes: [
            {
              kind: 'observation',
              text: `Observed readiness=${content.includes('"ready":true')}; restart counts ${Math.min(...restartCounts)} to ${Math.max(...restartCounts)}; running since ${content.match(/"startedAt":"([^"]+)"/)?.[1] ?? 'not observed in this slice'}.`,
              evidenceIds: [evidenceId],
            },
          ],
        };
      }
      expect(JSON.stringify(payload.reviewedEvidence)).toContain('restart counts 0');
      expect(JSON.stringify(payload.reviewedEvidence)).toContain('949');
      expect(JSON.stringify(payload.reviewedEvidence)).toContain('readiness=true');
      expect(JSON.stringify(payload.reviewedEvidence)).toContain('2026-09-13T01:00:00Z');
      return {
        supported: true,
        summary: 'Pod status is available.',
        reason: 'All admitted pod records were reviewed.',
        evidenceIds: [evidenceId],
      };
    }),
    candidate,
    [{ ...evidence, output }],
    new AbortController().signal,
  );
  expect(result.outcome).toBe('conclusive');
  const restored = JSON.parse(seen.join(''));
  expect(restored.output).toEqual(output);
});
