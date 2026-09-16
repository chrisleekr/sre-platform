import type { Author, HubMessage } from '@sre/hub';

/** Human input arriving from a surface, to be normalized into the hub. */
export interface SurfaceInput {
  content: string;
  author?: Author;
  /** Dashboard-generated UUID used as the durable idempotency key. */
  clientMessageId?: string;
}

/**
 * A thin surface adapter: it projects canonical hub messages onto its surface
 * and normalizes human input from that surface back into the hub. The dashboard WebSocket
 * is the first implementation; other surfaces (e.g. Slack) follow the same contract.
 */
export interface SurfaceAdapter {
  readonly surface: string;
  /** Render a hub message on the surface; `replay` marks history sent on connect rather than live. */
  project(msg: HubMessage, replay?: boolean): void | Promise<void>;
  /** Push human input from the surface into the hub; returns the appended message. */
  ingest(input: SurfaceInput): Promise<HubMessage>;
}
