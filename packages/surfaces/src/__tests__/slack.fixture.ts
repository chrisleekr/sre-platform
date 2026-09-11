import type { HubMessage } from '@sre/hub';
import { type FetchLike, type SurfaceTarget } from '../index';

export function createFixture() {
  /**
   * A target in the current shape: `{ token, channel }`, where `channel` is the channel the incident's
   * surface binding recorded (the alert's own channel), never a configured fan-out target.
   */
  const bound = (token: string, channel: string): SurfaceTarget => ({ token, channel });

  const msg = (over: Partial<HubMessage> = {}): HubMessage => ({
    id: 'm1',
    incidentId: 'i1',
    author: 'agent',
    kind: 'text',
    content: 'checkout is degraded',
    createdAt: 't',
    ...over,
  });

  function fakeFetch(
    result: unknown,
    ok = true,
    status = 200,
  ): {
    fetch: FetchLike;
    calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[];
  } {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
      [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({
        url,
        headers: init?.headers ?? {},
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      });
      return { ok, status, json: async () => result };
    };
    return { fetch, calls };
  }

  return {
    bound,
    msg,
    fakeFetch,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
