// Per-incident metric subscriber: polls an injected MetricSource on an interval and posts to the
// conversation hub only when a tracked metric moves past the delta threshold versus its previous
// reading. Ports are injected so this is pure-unit testable with no Postgres/Valkey/ConversationHub.
//
// Deferred (this issue ships the subscriber + manager + ports + tests only): the real MetricSource
// (a connector-backed metrics reader) and the worker lifecycle that subscribes on incident open and
// unsubscribes on resolution land with the connector poller / Kubernetes connector. Not
// wired into worker.ts / index.ts yet.

import type { NewMessage } from '@sre/hub';

/** Current value of each tracked metric for a service, keyed by metric name. */
export interface MetricSource {
  read(service: string): Promise<Record<string, number>>;
}

/**
 * Narrow append-only view of the conversation hub. Deliberately not the full `ConversationHub`
 * (which pulls Postgres + Valkey), so the subscriber stays infra-free. `NewMessage` is imported as a
 * type only, so a real `ConversationHub` is assignable here while nothing is loaded at runtime.
 */
export interface HubAppendPort {
  append(tenantId: string, incidentId: string, msg: NewMessage): Promise<unknown>;
}

/** A metric must move at least this fraction of its previous value to be reported. */
export const METRIC_DELTA_THRESHOLD = 0.2;

/** Default poll cadence. */
export const METRIC_POLL_INTERVAL_MS = 10_000;

export interface MetricSubscriberDeps {
  tenantId: string;
  incidentId: string;
  service: string;
  source: MetricSource;
  hub: HubAppendPort;
  /** Override the report threshold (fraction of previous value). Defaults to 20%. */
  threshold?: number;
}

/**
 * Watches one incident's service metrics. Each tick reads the current values and posts a hub note
 * for any metric whose change since the last reading is at or above the threshold. The first reading
 * of a metric only seeds the baseline; a zero baseline is reseeded without a delta calc to avoid
 * dividing by zero.
 */
export class MetricSubscriber {
  private readonly tenantId: string;
  private readonly incidentId: string;
  private readonly service: string;
  private readonly source: MetricSource;
  private readonly hub: HubAppendPort;
  private readonly threshold: number;
  private readonly last = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: MetricSubscriberDeps) {
    this.tenantId = deps.tenantId;
    this.incidentId = deps.incidentId;
    this.service = deps.service;
    this.source = deps.source;
    this.hub = deps.hub;
    this.threshold = deps.threshold ?? METRIC_DELTA_THRESHOLD;
  }

  /** True while the polling interval is active. */
  get running(): boolean {
    return this.timer !== null;
  }

  async tick(): Promise<void> {
    const readings = await this.source.read(this.service);
    for (const [name, value] of Object.entries(readings)) {
      const prev = this.last.get(name);
      // Report only with a non-zero baseline to measure against (guards divide-by-zero).
      if (prev !== undefined && prev !== 0) {
        const deltaRatio = (value - prev) / Math.abs(prev);
        if (Math.abs(deltaRatio) >= this.threshold) {
          const pct = Math.round(deltaRatio * 100);
          const sign = pct > 0 ? '+' : '';
          const content = `Metric "${name}" moved ${sign}${pct}% (${prev.toFixed(2)} → ${value.toFixed(2)}) on ${this.service}`;
          await this.hub.append(this.tenantId, this.incidentId, {
            author: 'system',
            kind: 'text',
            content,
          });
        }
      }
      this.last.set(name, value);
    }
  }

  /** Begin polling. Idempotent: a second call while running is a no-op. */
  start(intervalMs: number = METRIC_POLL_INTERVAL_MS): void {
    if (this.timer !== null) return;
    // A failed poll must not crash the interval; the next tick retries.
    this.timer = setInterval(() => void this.tick().catch(() => {}), intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export interface MetricSubscriberManagerDeps {
  source: MetricSource;
  hub: HubAppendPort;
}

export interface SubscribeRequest {
  tenantId: string;
  incidentId: string;
  service: string;
}

/** Owns one MetricSubscriber per incident: subscribe on open, unsubscribe on resolution. */
export class MetricSubscriberManager {
  private readonly subscribers = new Map<string, MetricSubscriber>();

  constructor(private readonly deps: MetricSubscriberManagerDeps) {}

  /** Idempotent: at most one subscriber per incident. */
  subscribe({ tenantId, incidentId, service }: SubscribeRequest): void {
    if (this.subscribers.has(incidentId)) return;
    const subscriber = new MetricSubscriber({
      tenantId,
      incidentId,
      service,
      source: this.deps.source,
      hub: this.deps.hub,
    });
    subscriber.start();
    this.subscribers.set(incidentId, subscriber);
  }

  unsubscribe(incidentId: string): void {
    const subscriber = this.subscribers.get(incidentId);
    if (!subscriber) return;
    subscriber.stop();
    this.subscribers.delete(incidentId);
  }

  has(incidentId: string): boolean {
    return this.subscribers.has(incidentId);
  }

  size(): number {
    return this.subscribers.size;
  }

  stopAll(): void {
    for (const subscriber of this.subscribers.values()) subscriber.stop();
    this.subscribers.clear();
  }
}
