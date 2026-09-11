import type { SurfaceDeliveryOperation, SurfaceDeliveryState } from '@sre/db';
import type { Surface, SurfaceRegistry } from '@sre/surfaces';

/** A non-blocking redis mutex (token-checked release), injected so fanout is unit-testable with a fake. */
export interface SurfaceLock {
  acquire(key: string): Promise<string | null>;
  renew(key: string, token: string): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
}

/** The conversation an incident was born in: the channel it lives in, and its root message. */
export interface ThreadBinding {
  channel: string;
  threadId: string;
}

export interface DeliveryTarget {
  surface: Surface;
  bindingId: string;
  bindingAssignmentVersion: number;
}

export interface FanoutDeps {
  registry: SurfaceRegistry;
  /** Serializes one bound conversation's mutable projection. */
  lock: SurfaceLock;
  /** Resolve an incident's tenant (system-level admin lookup). */
  resolveTenant: (incidentId: string) => Promise<string | null>;
  /** Destinations captured durably when this message committed. */
  listDeliveryTargets: (tenantId: string, messageId: string) => Promise<DeliveryTarget[]>;
  /** CAS queued -> sending. False means another worker or a terminal receipt already owns it. */
  claimDelivery: (
    tenantId: string,
    surface: Surface,
    bindingId: string,
    messageId: string,
  ) => Promise<boolean>;
  /** CAS sending -> terminal. */
  finishDelivery: (
    tenantId: string,
    surface: Surface,
    bindingId: string,
    messageId: string,
    result: {
      state: Exclude<SurfaceDeliveryState, 'queued' | 'sending'>;
      operation: SurfaceDeliveryOperation;
      remoteMessageId?: string | null;
      reasonCode?: string | null;
    },
  ) => Promise<boolean>;
  /** Move a safe retry to an eligible future time, guarded by its current state. */
  scheduleDeliveryRetry: (
    tenantId: string,
    surface: Surface,
    bindingId: string,
    messageId: string,
    expectedState: 'queued' | 'sending',
    retryAt: Date,
    reasonCode: 'dependency_unavailable' | 'projection_busy' | 'rate_limited',
  ) => Promise<boolean>;
  /** Record a definitive failure that occurred before any external request was attempted. */
  blockDelivery: (
    tenantId: string,
    surface: Surface,
    bindingId: string,
    messageId: string,
    reasonCode: 'not_connected' | 'missing_binding' | 'adapter_unavailable',
  ) => Promise<void>;
  /** The tenant's bot token for a surface (SecretStore), or null if unset. */
  getToken: (tenantId: string, surface: Surface) => Promise<string | null>;
  /**
   * A display label (email local-part) for the author of a human reply, for Slack attribution.
   * Best-effort and NEVER throws: any failure resolves to null so the reply still fans out unattributed.
   * Returns the full email's local-part only — the address itself never leaves the control plane.
   */
  resolveAuthorLabel: (tenantId: string, authorUserId: string) => Promise<string | null>;
  /**
   * Resolve the exact thread pinned by the durable delivery. Never infer a primary thread here: source
   * bindings need independent lifecycle projection and remain interactive after correlation changes.
   */
  getBinding: (
    tenantId: string,
    surface: Surface,
    bindingId: string,
  ) => Promise<ThreadBinding | null>;
  /** Platform-owned lifecycle reply and the newest version already projected to it. */
  getStatusPost: (
    tenantId: string,
    surface: Surface,
    bindingId: string,
  ) => Promise<{ messageId: string | null; version: number } | null>;
  /** Older ambiguous first-post attempts make another create unsafe. */
  hasAmbiguousStatusPostCreation: (
    tenantId: string,
    surface: Surface,
    bindingId: string,
    currentMessageId: string,
  ) => Promise<boolean>;
  advanceStatusPost: (
    tenantId: string,
    surface: Surface,
    bindingId: string,
    incidentId: string,
    assignmentVersion: number,
    messageId: string,
    version: number,
  ) => Promise<boolean>;
  /** The bound conversation's current mutable working-post message id, or null. */
  getWorkingPost: (tenantId: string, bindingId: string) => Promise<string | null>;
  /** Store the working-post message id (upsert) after creating it. */
  setWorkingPost: (tenantId: string, bindingId: string, messageId: string) => Promise<void>;
  /** Clear the working post once the turn concludes (reply/finding) or is dropped (silent). */
  clearWorkingPost: (tenantId: string, bindingId: string) => Promise<void>;
  /** Dashboard base URL for the takeaway deep-link; unset → no link is appended. */
  dashboardBaseUrl?: string;
  /** Best-effort error sink; `surface: 'resolve'` marks a pre-fan-out (tenant/config) failure. */
  onError?: (err: unknown, ctx: { incidentId: string; surface: Surface | 'resolve' }) => void;
  /** Injectable clock for durable retry eligibility; defaults to Date.now. */
  now?: () => number;
}

export interface OutboxRecoveryHint {
  tenantId: string;
  targets: DeliveryTarget[];
}
