// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { topologyMapProjection } from '../topology-map';
import { useTopologyMapLayout } from '../useTopologyMapLayout';

const state = vi.hoisted(() => ({
  fail: false,
  jobs: [] as {
    graph: ElkNode;
    resolve: (graph: ElkNode) => void;
    reject: (error: Error) => void;
    terminate: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock('elkjs/lib/elk-api.js', () => ({
  default: class {
    terminateWorker = vi.fn();
    constructor() {
      if (state.fail) throw new Error('Worker unavailable');
    }
    layout(graph: ElkNode) {
      return new Promise<ElkNode>((resolve, reject) =>
        state.jobs.push({ graph, resolve, reject, terminate: this.terminateWorker }),
      );
    }
  },
}));
afterEach(() => {
  cleanup();
  state.jobs.length = 0;
  state.fail = false;
});
const model = (key: string, stale = false) =>
  topologyMapProjection(
    [{ key, name: key, kind: 'service', scope: {}, resourceKeys: [key], sources: [], stale }],
    [],
    { mode: 'dependencies', focus: key },
  );

test('discards obsolete worker results and does not relayout for freshness-only updates', async () => {
  const { result, rerender } = renderHook(
    ({ key, stale }) => useTopologyMapLayout(model(key, stale)),
    { initialProps: { key: 'a', stale: false } },
  );
  rerender({ key: 'b', stale: false });
  expect(state.jobs[0]!.terminate).toHaveBeenCalledOnce();
  expect(result.current).toBeUndefined();
  await act(async () => state.jobs[1]!.resolve(state.jobs[1]!.graph));
  expect(result.current?.layout?.nodes.has('b')).toBe(true);
  await act(async () => state.jobs[0]!.resolve(state.jobs[0]!.graph));
  expect(result.current?.layout?.nodes.has('b')).toBe(true);
  rerender({ key: 'b', stale: true });
  expect(state.jobs).toHaveLength(2);
});

test('reports layout and worker startup failures instead of leaving an empty canvas', async () => {
  const { result, rerender } = renderHook(({ key }) => useTopologyMapLayout(model(key)), {
    initialProps: { key: 'a' },
  });
  await act(async () => state.jobs[0]!.reject(new Error('Invalid layout')));
  expect(result.current?.error).toBe(true);
  state.fail = true;
  rerender({ key: 'b' });
  expect(result.current?.error).toBe(true);
});
