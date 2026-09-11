import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Job } from '@sre/queue';
import type { VisionModel } from '../../engine/types';
import type { IncidentRow } from '../contracts';
import type { WorkerRuntime } from '../runtime';
import { WorkerEvidence } from '../evidence';

const dbMocks = vi.hoisted(() => ({
  uninterpretedImages: vi.fn(),
  setInterpretation: vi.fn(),
}));

vi.mock('@sre/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sre/db')>()),
  ...dbMocks,
}));

const job: Job = {
  id: 'job-1',
  tenantId: 'tenant-1',
  type: 'triage',
  attempts: 1,
  payload: {},
};

const incident = { id: 'incident-1', service: 'checkout' } as IncidentRow;
const bytes = new Uint8Array([1, 2, 3]).buffer;

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.uninterpretedImages.mockResolvedValue([
    {
      fileId: 'file-1',
      name: 'graph.png',
      mimetype: 'image/png',
      urlPrivate: 'https://files.slack.com/graph.png',
    },
  ]);
  dbMocks.setInterpretation.mockResolvedValue(undefined);
});

function runtime(
  executeVision: WorkerRuntime['executeVision'],
  vision: VisionModel,
): WorkerRuntime {
  return {
    deps: {
      appDb: {},
      llm: {},
      vision,
      fetchAttachment: vi.fn(async () => ({ bytes, contentType: 'image/png' })),
    },
    executeVision,
  } as unknown as WorkerRuntime;
}

describe('WorkerEvidence attachment interpretation', () => {
  test('passes the attempt signal through executeVision and interpretImage', async () => {
    const controller = new AbortController();
    const describeImage = vi.fn(
      async (
        _bytes: ArrayBuffer,
        _mime: string,
        _prompt: string,
        options?: { signal?: AbortSignal },
      ) => {
        expect(options).toEqual({ signal: controller.signal });
        return 'description';
      },
    );
    const vision: VisionModel = { provider: 'fake', supportsVision: true, describeImage };
    const executeVision = vi.fn(async (_job, _incidentId, signal, run) => {
      expect(signal).toBe(controller.signal);
      return run(vision);
    });
    const evidence = new WorkerEvidence(runtime(executeVision, vision));

    await expect(
      evidence.interpretAttachments(job, incident, controller.signal),
    ).resolves.toContain('description');
    expect(executeVision).toHaveBeenCalledTimes(1);
    expect(describeImage).toHaveBeenCalledTimes(1);
    expect(dbMocks.setInterpretation).toHaveBeenCalledWith(
      {},
      'tenant-1',
      'incident-1',
      'file-1',
      'description',
    );
  });

  test('rethrows the attempt reason instead of persisting a reference-only fallback', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    const vision: VisionModel = {
      provider: 'fake',
      supportsVision: true,
      describeImage: vi.fn(async () => 'description'),
    };
    const executeVision = vi.fn(async (_job, _incidentId, _signal, run) => {
      controller.abort(reason);
      return run(vision);
    });
    const evidence = new WorkerEvidence(runtime(executeVision, vision));

    await expect(evidence.interpretAttachments(job, incident, controller.signal)).rejects.toBe(
      reason,
    );
    expect(dbMocks.setInterpretation).not.toHaveBeenCalled();
  });
});
