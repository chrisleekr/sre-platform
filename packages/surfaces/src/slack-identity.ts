import { SLACK_API, slackApiGet } from './slack-http';
import type { FetchLike } from './types';

interface UsersInfoResult {
  ok: boolean;
  user?: { profile?: { email?: string | null } };
}

const USERS_INFO_TIMEOUT_MS = 1_000;

/**
 * Resolves a Slack user email without failing the parent interaction.
 *
 * @remarks Missing scopes, transport errors, and timeouts return null because attribution is optional.
 * @param fetchImpl - HTTP implementation used for the Slack request.
 * @param token - Tenant Slack bot token.
 * @param userId - Slack user identifier to resolve.
 */
export async function slackUsersInfoEmail(
  fetchImpl: FetchLike,
  token: string,
  userId: string,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`${SLACK_API}/users.info?user=${encodeURIComponent(userId)}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      // Fail open before Slack's three-second interaction acknowledgement deadline.
      signal: AbortSignal.timeout(USERS_INFO_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as UsersInfoResult;
    return data.ok ? (data.user?.profile?.email ?? null) : null;
  } catch {
    return null;
  }
}

interface ChatGetPermalinkResult {
  ok: boolean;
  permalink?: string;
}

const GET_PERMALINK_TIMEOUT_MS = 3_000;

/**
 * Resolves a best-effort permalink for an existing Slack message.
 *
 * @remarks Any Slack or transport failure returns null because breadcrumbs must not block delivery.
 * @param fetchImpl - HTTP implementation used for the Slack request.
 * @param token - Tenant Slack bot token.
 * @param channel - Slack channel containing the message.
 * @param messageTs - Slack timestamp identifying the message.
 */
export async function slackChatGetPermalink(
  fetchImpl: FetchLike,
  token: string,
  channel: string,
  messageTs: string,
): Promise<string | null> {
  try {
    const { ok, body } = await slackApiGet<ChatGetPermalinkResult>(
      fetchImpl,
      token,
      'chat.getPermalink',
      new URLSearchParams({ channel, message_ts: messageTs }),
      { signal: AbortSignal.timeout(GET_PERMALINK_TIMEOUT_MS) },
    );
    return ok && body?.ok ? (body.permalink ?? null) : null;
  } catch {
    return null;
  }
}
