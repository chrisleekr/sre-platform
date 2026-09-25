import type { Db } from '@sre/db';
import type { ConversationHub } from '@sre/hub';
import type { RouteDeps } from '../route-to-incident';

export interface NativeLifecycleDeps {
  appDb: Db;
  route: RouteDeps;
  hub: ConversationHub;
  postAlertRoot: (
    tenantId: string,
    channel: string,
    text: string,
    intakeId: string,
  ) => Promise<string>;
  dashboardBaseUrl?: string;
  log?: { error(message: string, fields?: Record<string, unknown>): void };
}

export type NativeLifecycleOutcome =
  | 'accepted'
  /** A repeat notice for a cycle no real trigger retained; nothing was written. */
  | 'acknowledged'
  | 'deferred'
  | 'retry'
  | 'unsubscribed'
  | 'conflicting_episode_times'
  | 'binding_episode_mismatch'
  | 'native_cycle_association_required';
