import {
  incidents,
  isChannelSubscribed,
  lookupSurfaceIdentity,
  persistSurfaceIdentity,
  resolveUserByEmail,
  type Tx,
} from '@sre/db';
import type { HubMessage } from '@sre/hub';
import { and, eq } from 'drizzle-orm';
import type { SlackConfig, SlackFile, SlackInboundDeps } from './contracts';

export function parseSlackFiles(
  files: SlackFile[] | undefined,
): { fileId: string; name: string; mimetype: string; urlPrivate: string; permalink?: string }[] {
  return (files ?? [])
    .filter((f): f is SlackFile & { id: string; url_private: string } =>
      Boolean(f.id && f.url_private),
    )
    .map((f) => ({
      fileId: f.id,
      name: f.name ?? f.id,
      mimetype: f.mimetype ?? 'application/octet-stream',
      urlPrivate: f.url_private,
      permalink: f.permalink,
    }));
}

/** Remove our bot's `<@U…>` mention token from a message so the resumed instruction reads cleanly. */
export function stripMention(text: string, botUserId: string): string {
  if (!botUserId) return text.trim();
  return text.split(`<@${botUserId}>`).join('').trim();
}

export async function appendSourceThreadNoticeTx(
  deps: SlackInboundDeps,
  tx: Tx,
  tenantId: string,
  binding: { incidentId: string; role: string },
  humanMessageId: string,
): Promise<HubMessage | null> {
  if (binding.role !== 'source') return null;
  return (
    await deps.hub.appendTxOnce(tx, tenantId, binding.incidentId, {
      author: 'system',
      kind: 'relationship',
      content:
        'Question received from a linked alert thread. The SRE will answer in the primary investigation; this thread continues to receive lifecycle and relationship updates.',
      originMessageId: `source-thread-redirect:${humanMessageId}`,
    })
  ).message;
}

export async function appendHumanReceiptTx(
  deps: SlackInboundDeps,
  tx: Tx,
  tenantId: string,
  incidentId: string,
  humanMessageId: string,
): Promise<HubMessage> {
  return (
    await deps.hub.appendTxOnce(tx, tenantId, incidentId, {
      author: 'agent',
      // A reply is permanent on chat surfaces. A narration text would be immediately overwritten by
      // the next tool step in the mutable working post, making acceptance effectively invisible.
      kind: 'reply',
      content: 'Message received. Investigating…',
      originMessageId: `slack-receipt:${humanMessageId}`,
    })
  ).message;
}

/** Negative-identity cache key, tenant-first like the funnel's `dedup:` key. */
const noIdentityKey = (tenantId: string, surface: string, surfaceUserId: string): string =>
  `noident:${tenantId}:${surface}:${surfaceUserId}`;

/**
 * How long a confirmed non-member is remembered. 60s collapses a chatty non-member from one
 * users.info call per message to at most one per minute, which is nearly all of the win because the cost
 * is per-message in a burst, while keeping the window short enough that membership stays a JOIN needing
 * no repair step: a member provisioned after a cached miss self-heals within a minute.
 */
const NO_IDENTITY_TTL_SEC = 60;

/**
 * Resolve a human reply's Slack author id to a tenant member's user id for attribution. Cache
 * first (surface_identities): a hit returns the mapping WITHOUT a users.info call. On a miss, look up the
 * author's email (deps.usersInfoEmail) and resolve it to exactly-one tenant member (resolveUserByEmail,
 * never-wrong-person), then cache the mapping. Returns null on any miss — no email, no/ambiguous match,
 * or unconfigured resolver. NON-FATAL: every failure is swallowed to null so ingestion still proceeds;
 * called BEFORE the append tx so the resolve's network I/O never holds a DB connection open.
 *
 * A confirmed non-member is negatively cached. Only successes were cached before, so every
 * message from an unresolvable author repeated the users.info round-trip. Authentication may create a
 * membership after a provider binding succeeds, but Slack ingestion never creates one; the short cache
 * therefore self-heals after a participant first signs in or an administrator assigns access.
 */
export async function resolveAuthorUserId(
  deps: SlackInboundDeps,
  config: SlackConfig,
  surface: string,
  surfaceUserId: string,
): Promise<string | null> {
  if (!surfaceUserId) return null;
  try {
    const cached = await lookupSurfaceIdentity(deps.appDb, config.tenantId, surface, surfaceUserId);
    if (cached) return cached;
    if (!deps.usersInfoEmail) return null;
    // Both Valkey calls are guarded INDIVIDUALLY rather than left to the outer catch: that catch returns
    // null, so an unguarded throw here would silently un-attribute everyone, real members included, for
    // the length of a blip. Attribution does not otherwise depend on Valkey, so a cache added to make
    // this path cheaper must degrade to the old behaviour, never below it. Read failure reads as a miss.
    const key = noIdentityKey(config.tenantId, surface, surfaceUserId);
    if (await deps.redis.get(key).catch(() => null)) return null;
    const email = await deps.usersInfoEmail(config.tenantId, surfaceUserId);
    const userId = await resolveUserByEmail(deps.adminDb, config.tenantId, email);
    if (!userId) {
      // Best-effort, mirroring persistSurfaceIdentity below: a write failure costs the caching only.
      await deps.redis.set(key, '1', 'EX', NO_IDENTITY_TTL_SEC).catch(() => {});
      return null;
    }
    // Cache is best-effort: a write failure must not discard an attribution we already resolved.
    await persistSurfaceIdentity(deps.appDb, config.tenantId, {
      surface,
      surfaceUserId,
      authorUserId: userId,
      source: 'auto',
    }).catch(() => {});
    return userId;
  } catch {
    return null; // attribution is best-effort; a failed resolve must never drop the reply
  }
}

/**
 * Inbound opt-in gate: the source channel must be subscribed AND enabled. Subscribing a
 * channel IS the opt-in — there is no separate per-config inbound flag to also flip (a connected Slack
 * with zero subscribed channels already ingests nothing).
 */
export async function inboundAllowed(
  deps: SlackInboundDeps,
  config: SlackConfig,
  channel: string,
): Promise<boolean> {
  return isChannelSubscribed(deps.appDb, config.tenantId, 'slack', channel);
}

/** The slice of a Slack interactivity payload used by approval and incident-lifecycle buttons. */

export async function incidentAcceptsReplyTx(
  tx: Tx,
  tenantId: string,
  incidentId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ archivedAt: incidents.archivedAt })
    .from(incidents)
    .where(and(eq(incidents.tenantId, tenantId), eq(incidents.id, incidentId)))
    .limit(1)
    .for('update');
  return Boolean(rows[0] && !rows[0].archivedAt);
}
