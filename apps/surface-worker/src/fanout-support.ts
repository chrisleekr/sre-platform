import type { SurfaceDeliveryOperation } from '@sre/db';
import type { HubMessage } from '@sre/hub';
import type { FanoutDeps, SurfaceLock, ThreadBinding } from './fanout-contracts';

const MEMO_MAX_ENTRIES = 10_000;

/** Per-incident destination cache. The binding is immutable for the incident's lifetime. */
interface DestinationMemo {
  binding?: ThreadBinding;
}

// Keyed by the deps object identity: production builds deps ONCE and reuses it per message, so the memo
// lives for the process; each test builds fresh deps, so caches never bleed across tests. [T1]
const destinationMemo = new WeakMap<FanoutDeps, Map<string, DestinationMemo>>();

export function memoFor(deps: FanoutDeps, key: string): DestinationMemo {
  let byKey = destinationMemo.get(deps);
  if (!byKey) {
    byKey = new Map();
    destinationMemo.set(deps, byKey);
  }
  let memo = byKey.get(key);
  if (!memo) {
    // Evict the oldest-inserted key before inserting a new one past the cap (Map preserves insertion
    // order). Eviction only forces a re-read of that incident's token/binding, never a correctness loss.
    if (byKey.size >= MEMO_MAX_ENTRIES) {
      const oldest = byKey.keys().next().value;
      if (oldest !== undefined) byKey.delete(oldest);
    }
    memo = {};
    byKey.set(key, memo);
  }
  return memo;
}

const OPEN_LOCK_TRIES = 20;
const OPEN_LOCK_DELAY_MS = 100;
export const SAFE_RETRY_DELAY_MS = 5_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retry the non-blocking lock so a loser waits for the holder to finish; give up after a bounded wait. */
export async function acquireBlocking(lock: SurfaceLock, key: string): Promise<string | null> {
  for (let i = 0; i < OPEN_LOCK_TRIES; i++) {
    const token = await lock.acquire(key);
    if (token) return token;
    await sleep(OPEN_LOCK_DELAY_MS);
  }
  return null;
}

/** A short friendly activity line for a narration step; the raw detail stays in the hub, not on Slack. */
export function activityLine(msg: HubMessage): string {
  if (msg.kind === 'tool_step') {
    // tool_step content is "<tool_name> <json args>"; surface the tool, drop the args.
    const tool = msg.content.trim().split(/\s+/)[0] ?? '';
    return tool ? `🔍 Running ${tool.replace(/_/g, ' ')}…` : '🔍 Investigating…';
  }
  return `🔍 ${msg.content}`; // a text narration line is already concise
}

/**
 * Project one hub message onto ONE bound conversation. The engine writes
 * only the hub; this adapter maintains a single MUTABLE "working post" per turn (
 *): agent `text`/`tool_step` create-or-update a short activity post; agent `reply`/`finding`
 * fold it into the terminal answer (+ dashboard link) and clear it; agent `silent` deletes it.
 * System-authored messages (degrade brief) and `approval` post normally, never through the working
 * post. EVERY post threads under the delivery's binding — the conversation selected when it committed.
 * Nothing here opens a thread: the thread already exists (it is the alert), and the binding was written
 * with the incident. Returns the operation needed for the durable delivery receipt.
 */
export interface SurfaceApplyResult {
  operation: SurfaceDeliveryOperation;
  remoteMessageId: string | null;
  skipped?: boolean;
  skipReason?: 'stale_lifecycle_version' | 'nothing_to_delete';
}

export class LifecycleProjectionBlockedError extends Error {
  constructor() {
    super('lifecycle status post creation is ambiguous');
    this.name = 'LifecycleProjectionBlockedError';
  }
}
