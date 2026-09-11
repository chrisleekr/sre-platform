import type { Redis } from 'ioredis';
import type { HubMessage } from '@sre/hub';

// Minimal Valkey Streams consumer group over the surface fan-out stream (the message payload is IN the
// entry; the durable source is incident_messages, written by the hub before the XADD).
// Competing consumers give one delivery per message across replicas; XAUTOCLAIM reclaims a crashed
// consumer's pending entries. Mirrors @sre/queue's process() without the jobs table.

type StreamEntry = [id: string, fields: string[]];

function fieldValue(fields: string[], key: string): string | undefined {
  const i = fields.indexOf(key);
  return i >= 0 ? fields[i + 1] : undefined;
}

export interface SurfaceConsumerOpts {
  stream: string;
  group: string;
  consumer: string;
  count?: number;
  idleMs?: number;
}

// A deferred entry (handler returned false) is left un-acked for XAUTOCLAIM redelivery, but only up to
// MAX_ATTEMPTS so a permanently-undeliverable entry can't poison-loop; RETRY_TTL_SEC expires the counter.
const MAX_ATTEMPTS = 5;
const RETRY_TTL_SEC = 3600;

export async function ensureSurfaceGroup(
  redis: Redis,
  stream: string,
  group: string,
): Promise<void> {
  try {
    await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes('BUSYGROUP')) throw e;
  }
}

/**
 * One consume pass: reclaim idle pending entries + read new ones, run the handler for each, then XACK.
 * The handler returns whether the entry was handled: an entry it defers (returns false) is left un-acked
 * so XAUTOCLAIM redelivers it, bounded by MAX_ATTEMPTS to prevent a poison-loop (then acked; the durable
 * log retains it). A throwing handler is best-effort and acked. Returns the number of entries processed.
 */
export async function surfaceStreamTick(
  redis: Redis,
  opts: SurfaceConsumerOpts,
  handler: (msg: HubMessage) => Promise<boolean>,
): Promise<number> {
  const count = opts.count ?? 20;
  const idleMs = opts.idleMs ?? 60_000;
  const entries: StreamEntry[] = [];

  const claimed = (await redis.xautoclaim(
    opts.stream,
    opts.group,
    opts.consumer,
    idleMs,
    '0',
    'COUNT',
    count,
  )) as unknown as [string, StreamEntry[], string[]];
  entries.push(...(claimed[1] ?? []));

  const read = (await redis.xreadgroup(
    'GROUP',
    opts.group,
    opts.consumer,
    'COUNT',
    count,
    'STREAMS',
    opts.stream,
    '>',
  )) as unknown as Array<[string, StreamEntry[]]> | null;
  if (read) for (const [, msgs] of read) entries.push(...msgs);

  let processed = 0;
  for (const [id, fields] of entries) {
    let handled = true;
    const raw = fieldValue(fields, 'msg');
    if (raw) {
      try {
        handled = await handler(JSON.parse(raw) as HubMessage);
      } catch {
        handled = true; // errors are best-effort: ack, do not poison-loop
      }
    }

    let ack = handled;
    if (!handled) {
      // Seed the counter with a TTL atomically (SET NX EX) so a crash between INCR and a separate
      // EXPIRE can't leak a no-TTL key; INCR then preserves that TTL. Stream ids are monotonic, so
      // a per-entry counter never collides with a future entry.
      await redis.set(`surfretry:${id}`, '0', 'EX', RETRY_TTL_SEC, 'NX');
      const n = await redis.incr(`surfretry:${id}`);
      if (n >= MAX_ATTEMPTS) {
        ack = true; // give up: leave it to the durable log, don't wedge the group
        await redis.del(`surfretry:${id}`);
        console.warn(
          JSON.stringify({
            level: 'warn',
            app: 'surface-worker',
            msg: 'surface delivery gave up after max attempts',
            entry: id,
          }),
        );
      }
    }

    if (ack) {
      await redis.xack(opts.stream, opts.group, id);
      processed++;
    }
  }
  return processed;
}
