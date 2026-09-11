import type { HubMessage } from '@sre/hub';
import {
  SurfaceRegistry,
  type Surface,
  type SurfacePoster,
  type SurfaceTarget,
} from '@sre/surfaces';
import { type FanoutDeps, type SurfaceLock, type ThreadBinding } from '../fanout';

interface Recorded {
  posts: { target: SurfaceTarget; thread: string; link?: string | null; msg: HubMessage }[];
  updates: { target: SurfaceTarget; id: string; link?: string | null; msg: HubMessage }[];
  deletes: { target: SurfaceTarget; id: string }[];
}

export function createFixture() {
  // Every incident is born bound to the conversation it arrived in, so the fan-out always has a
  // thread to post into and never opens one. This is the default fixture thread.
  const BOUND: ThreadBinding = { channel: 'chat-1', threadId: 'root-ts' };

  const BINDING_ID = 'binding-1';

  // The poster receives the thread STRUCTURALLY: the channel in `target`, the thread id verbatim. No
  // composite string ever reaches app code (a Teams conversation id contains ':' — a joined key breaks).
  const BOUND_THREAD = BOUND.threadId;

  const msg = (over: Partial<HubMessage> = {}): HubMessage => ({
    id: 'm1',
    incidentId: 'i1',
    author: 'agent',
    kind: 'text',
    content: 'hi',
    createdAt: 't',
    ...over,
  });

  // Surface typed as string so a test-only literal (e.g. 'other') can stand in for a second distinct
  // surface without widening the production Surface union. The fan-out compares surfaces as plain strings.
  function fakePoster(surface: string): { poster: SurfacePoster } & Recorded {
    const posts: Recorded['posts'] = [];
    const updates: Recorded['updates'] = [];
    const deletes: Recorded['deletes'] = [];
    let seq = 0;
    const poster: SurfacePoster = {
      surface: surface as Surface,
      post: async (target, thread, m, link) => {
        posts.push({ target, thread, link, msg: m });
        return `ts${++seq}`; // the posted message's id (stored as the working post)
      },
      update: async (target, id, m, link) => void updates.push({ target, id, link, msg: m }),
      delete: async (target, id) => void deletes.push({ target, id }),
    };
    return { poster, posts, updates, deletes };
  }

  /** A lock that always grants immediately (no contention). */
  const freeLock: SurfaceLock = {
    acquire: async () => 'tok',
    renew: async () => true,
    release: async () => {},
  };

  /** In-memory working-post store, keyed by conversation binding. */
  function wpStore() {
    const m = new Map<string, string>();
    return {
      get: async (_t: string, bindingId: string) => m.get(bindingId) ?? null,
      set: async (_t: string, bindingId: string, ts: string) => void m.set(bindingId, ts),
      clear: async (_t: string, bindingId: string) => void m.delete(bindingId),
      map: m,
    };
  }

  function baseDeps(over: Partial<FanoutDeps> = {}): FanoutDeps {
    const wp = wpStore();
    const statusPosts = new Map<string, { messageId: string | null; version: number }>();
    const statusKey = (tenantId: string, surface: string, incidentId: string) =>
      `${tenantId}:${surface}:${incidentId}`;
    return {
      registry: new SurfaceRegistry(),
      lock: freeLock,
      resolveTenant: async () => 't1',
      listDeliveryTargets: async () => [
        { surface: 'slack', bindingId: BINDING_ID, bindingAssignmentVersion: 0 },
      ],
      claimDelivery: async () => true,
      finishDelivery: async () => true,
      scheduleDeliveryRetry: async () => true,
      blockDelivery: async () => {},
      getToken: async () => 'BOT',
      resolveAuthorLabel: async () => null,
      getBinding: async () => BOUND,
      getStatusPost: async (tenantId, surface, incidentId) =>
        statusPosts.get(statusKey(tenantId, surface, incidentId)) ?? {
          messageId: null,
          version: 0,
        },
      hasAmbiguousStatusPostCreation: async () => false,
      advanceStatusPost: async (
        tenantId,
        surface,
        bindingId,
        _incidentId,
        _assignmentVersion,
        messageId,
        version,
      ) => {
        statusPosts.set(statusKey(tenantId, surface, bindingId), { messageId, version });
        return true;
      },
      getWorkingPost: wp.get,
      setWorkingPost: wp.set,
      clearWorkingPost: wp.clear,
      ...over,
    };
  }

  /** Deps that persist the working post across sequential fanout calls (a live incident thread). */
  function liveDeps(registry: SurfaceRegistry, over: Partial<FanoutDeps> = {}): FanoutDeps {
    return baseDeps({ registry, ...over });
  }

  return {
    BOUND,
    BINDING_ID,
    BOUND_THREAD,
    msg,
    fakePoster,
    freeLock,
    wpStore,
    baseDeps,
    liveDeps,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
