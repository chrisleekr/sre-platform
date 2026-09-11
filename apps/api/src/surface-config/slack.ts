import { SLACK_API, nextCursor, slackApiGet, type FetchLike } from '@sre/surfaces';
import { safeErrorMetadata } from '../logger';
import type { SurfaceRoutesDeps } from '../surface-config';

export const SLACK = 'slack' as const;

const CHANNELS_PAGE_LIMIT = 200; // conversations.list page size; paginate on next_cursor up to the cap.
// Bound the cursor loop: 50 pages x 200 = 10k channels, far past any real workspace. Slack repeating a
// cursor (or a pathological workspace) must not spin the handler forever. Hitting the cap means the list
// is PARTIAL, and the caller is told so (`truncated`) — a silently short list sends the operator hunting
// for a channel that is simply not in the picker.
const CHANNELS_MAX_PAGES = 50;
// conversations.list is Tier-2 rate-limited and walks up to 50 pages. The dashboard used to ask for it on
// every mount, so a handful of open tabs could earn a 429. 5 minutes: long enough to absorb the reloads,
// short enough that a newly-invited channel shows up without an obscure wait.
export const CHANNELS_CACHE_TTL_SEC = 300;
// Both rate-limit paths (HTTP 429, and a 200 body with ok:false/error:'ratelimited') say the same thing to
// the operator: nothing is misconfigured, just wait. One constant so they can never drift apart.
const RATE_LIMIT_MESSAGE =
  'Slack rate-limited the channel list. Wait for the retry-after window Slack returned, then try again.';
// Production wires the raw global fetch, which has no default timeout: a Slack outage that accepts the
// connection and never answers would wedge the handler. Mirrors packages/surfaces/src/slack-file.ts.
const SLACK_FETCH_TIMEOUT_MS = 15_000;
// A Slack app without these cannot enumerate channels; naming them IS the remedy the operator needs.
const CHANNEL_SCOPES = 'channels:read (and groups:read for private channels)';
/**
 * Defensive attribution warning. Connection validation now calls bots.info first, so users:read is
 * required and a later users.info missing_scope should be unreachable. If Slack reports that inconsistent
 * state, keep the advisory; users:read.email remains optional and cannot be detected from users.info.
 *
 * Names BOTH scopes unconditionally and NEVER narrows to Slack's `needed`. That is the opposite of the
 * missing_scope arm in slackAvailableChannels below, deliberately: there, `needed` names all four
 * conversation scopes and is COMPLETE, so echoing Slack beats a hardcoded guess that could go stale. Here
 * `needed` can only ever say `users:read`, because `users:read.email` is not required to CALL users.info,
 * only to SEE the email field it returns. Deferring to it would name half the requirement — the operator
 * grants users:read, re-tests, users.info now succeeds, the warning vanishes, and they stop while email
 * attribution stays permanently dead. `needed`/`provided` are not echoed at all: for this method they can
 * only ever be a subset of the pair below, so they would add words without adding a remedy.
 */
const ATTRIBUTION_SCOPE_WARNING =
  'Slack rejected users.info with missing_scope, so author attribution is not working: replies and ' +
  'approvals will be recorded with no author. Add the users:read and users:read.email bot scopes to the ' +
  'Slack app, then reinstall it. Add both: Slack requires them together, and this test cannot detect ' +
  'users:read.email on its own — without it users.info still succeeds and simply omits the email.';
/**
 * A Slack conversation id: a C/G/D prefix plus uppercase alphanumerics
 * (https://docs.slack.dev/apis/web-api/using-the-conversations-api/). Anchored at BOTH ends — a typed
 * "#name", or a name that merely starts with an uppercase C/G/D ("Deploys"), can never match an inbound
 * event, so storing one silently drops every message in that channel.
 */
export const SLACK_CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;

export function logConnectionFailure(
  deps: SurfaceRoutesDeps,
  fields: {
    tenantId: string;
    stage: string;
    status: number;
    error: string;
    cause?: unknown;
    teamId?: string;
    configId?: string;
  },
): void {
  const { cause, ...safeFields } = fields;
  deps.log?.error('Slack surface connection failed', {
    surface: SLACK,
    ...safeFields,
    ...(cause === undefined ? {} : safeErrorMetadata(cause)),
  });
}

/**
 * Probe users.info for the one scope gap it can PROVE, and return the warning to hang on an otherwise
 * passing connect. `botUserId` is the bot auth.test just handed back, so the subject is already in
 * hand and this costs no extra lookup.
 *
 * ONE-DIRECTIONAL: the only answers are "definitely missing" and silence. users.info is a `users:read`
 * method, so without that scope Slack refuses it with the documented `missing_scope`. `users:read.email`
 * has no such tell on any documented surface: without it users.info still SUCCEEDS and merely omits
 * profile.email — which is also what a BOT user returns normally, so probing the bot's own id cannot tell
 * the two apart. (The only reliable signal is the undocumented x-oauth-scopes header, which we do not
 * depend on.) So a clean probe earns silence, never a "scopes OK": a green check that cannot see half the
 * requirement is worse than no check.
 *
 * Never throws, and every non-proof degrades to undefined — a Slack we could not reach says NOTHING about
 * scopes, and auth.test has already proved the token, so the fail direction is silent rather than
 * alarming: an invented warning would send the operator to fix a non-problem.
 *
 * Local to the config routes rather than added to @sre/surfaces: that package holds the runtime paths,
 * and its slackUsersInfoEmail carries a 1s deadline sized against Slack's 3s acknowledgement budget.
 * Connect has no acknowledgement budget, so this takes the file's SLACK_FETCH_TIMEOUT_MS.
 */
export async function slackScopeWarning(
  fetchImpl: FetchLike,
  token: string,
  botUserId: string,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${SLACK_API}/users.info?user=${encodeURIComponent(botUserId)}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      // The raw global fetch has no default timeout: a Slack that accepts the connection and never
      // answers would wedge a handler whose real work is already done.
      signal: AbortSignal.timeout(SLACK_FETCH_TIMEOUT_MS),
    });
    // Slack answers logical failures with HTTP 200 + ok:false, so a non-2xx is a transport fault, which
    // proves nothing about scopes.
    if (!res.ok) return undefined;
    const body = (await res.json()) as { ok?: boolean; error?: string };
    // The one gap this can prove. Anything else — a success, user_not_found, a rate limit — is not
    // evidence of a missing scope, so it earns silence.
    return !body.ok && body.error === 'missing_scope' ? ATTRIBUTION_SCOPE_WARNING : undefined;
  } catch {
    // Unreachable, timed out, or an unparseable body: silence, per the fail direction above.
    return undefined;
  }
}

/** A channel the bot can see, as the operator picks it: the ID inbound events carry + its display name. */
export interface AvailableChannel {
  id: string;
  name: string;
}

interface ConversationsListResponse {
  ok?: boolean;
  error?: string;
  /** On missing_scope Slack names the scopes it wanted and the ones the token carries. */
  needed?: string;
  provided?: string;
  channels?: { id?: string; name?: string }[];
  response_metadata?: { next_cursor?: string };
}

/** Slack answered ok:false. The message is operator-facing; the route maps it to a 400, never a 500. */
export class SlackApiError extends Error {}

/** The channel list plus whether the page cap cut it short. */
export interface AvailableChannelsResult {
  channels: AvailableChannel[];
  truncated: boolean;
}

/**
 * Every channel the bot can see, via conversations.list. The operator PICKS from this list:
 * Slack events only ever carry channel IDs, so a hand-typed "#name" could never match an inbound
 * message. Private channels appear only once the bot has been INVITED to them. Paginated on next_cursor
 * up to CHANNELS_MAX_PAGES; hitting the cap returns `truncated:true` rather than pretending the short
 * list is the whole workspace. The token rides a Bearer header, never the URL.
 */
export async function slackAvailableChannels(
  fetchImpl: FetchLike,
  token: string,
): Promise<AvailableChannelsResult> {
  const out: AvailableChannel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < CHANNELS_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      types: 'public_channel,private_channel',
      exclude_archived: 'true',
      limit: String(CHANNELS_PAGE_LIMIT),
    });
    if (cursor) params.set('cursor', cursor);
    // Per-page timeout: the raw global fetch has none, so a Slack that accepts the connection but never
    // answers would wedge the handler. A fresh signal per page bounds each request, not the whole walk.
    const res = await slackApiGet<ConversationsListResponse>(
      fetchImpl,
      token,
      'conversations.list',
      params,
      { signal: AbortSignal.timeout(SLACK_FETCH_TIMEOUT_MS) },
    );
    // conversations.list is rate-limited; a bare "HTTP 429" tells the operator nothing actionable.
    if (res.status === 429) throw new SlackApiError(RATE_LIMIT_MESSAGE);
    if (!res.ok) throw new SlackApiError(`Slack returned HTTP ${res.status}`);
    const body = res.body;
    // Slack answers HTTP 200 with ok:false on a logical failure; the `ok` flag is the real status.
    if (!body?.ok) {
      const err = body?.error ?? 'conversations_list_failed';
      // Slack also reports a rate limit in the BODY of a 200 (ok:false, error:'ratelimited'). Read as a
      // generic refusal it looks like a misconfiguration and sends the operator to check their scopes.
      if (err === 'ratelimited') throw new SlackApiError(RATE_LIMIT_MESSAGE);
      if (err !== 'missing_scope') throw new SlackApiError(`Slack rejected the request: ${err}`);
      // Prefer Slack's own `needed` over a hardcoded list: the docs name all four conversation scopes
      // for this method and do not document a per-type subset, so any guess we bake in risks telling
      // the operator to add scopes that still leave the call failing. Slack's answer cannot be stale.
      const needed = body?.needed?.trim() || CHANNEL_SCOPES;
      const have = body?.provided?.trim();
      throw new SlackApiError(
        `Slack rejected the request: missing_scope. Add these scopes to the Slack app and reinstall it: ${needed}.` +
          (have ? ` The bot token currently has: ${have}.` : ''),
      );
    }
    for (const ch of body.channels ?? []) {
      // Slack's own name, verbatim (no leading '#'); presentation is the dashboard's business.
      if (ch.id && ch.name) out.push({ id: ch.id, name: ch.name });
    }
    cursor = nextCursor(body);
    if (!cursor) return { channels: out, truncated: false };
  }
  // Hit the page cap with a cursor still outstanding: return what we have rather than loop forever, and
  // SAY that it is partial. The picker still works; the operator is told a channel may be missing from it.
  return { channels: out, truncated: true };
}

/** Tenant-facing surface connection + Slack probes + inbound channel subscription. */
