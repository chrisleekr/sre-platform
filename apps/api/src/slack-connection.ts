import { SLACK_API, type FetchLike } from '@sre/surfaces';

const SLACK_IDENTITY_TIMEOUT_MS = 15_000;

export interface SlackConnectionIdentity {
  botUserId: string;
  botId: string;
  teamId: string;
  appId: string;
}

export class SlackConnectionError extends Error {
  constructor(
    readonly stage: string,
    message: string,
  ) {
    super(message);
  }
}

export function slackAppIdFromToken(token: string): string | undefined {
  return /^xapp-1-(A[A-Z0-9]+)-/.exec(token)?.[1];
}

/** Validate both Slack credentials and prove that they belong to the same app. */
export async function validateSlackConnection(
  fetchImpl: FetchLike,
  botToken: string,
  appToken: string,
): Promise<SlackConnectionIdentity> {
  const expectedAppId = slackAppIdFromToken(appToken);
  if (!expectedAppId) throw new SlackConnectionError('app_token_shape', 'invalid_app_token');

  const authRes = await fetchImpl(`${SLACK_API}/auth.test`, {
    method: 'POST',
    headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(SLACK_IDENTITY_TIMEOUT_MS),
  });
  const auth = (await authRes.json()) as {
    ok?: boolean;
    user_id?: string;
    bot_id?: string;
    team_id?: string;
    error?: string;
  };
  if (!authRes.ok || !auth.ok || !auth.user_id || !auth.bot_id || !auth.team_id) {
    throw new SlackConnectionError(
      'bot_auth_test',
      auth.error ?? (auth.ok && !auth.bot_id ? 'bot_token_required' : 'auth_test_incomplete'),
    );
  }

  const botRes = await fetchImpl(`${SLACK_API}/bots.info?bot=${encodeURIComponent(auth.bot_id)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(SLACK_IDENTITY_TIMEOUT_MS),
  });
  const botBody = (await botRes.json()) as {
    ok?: boolean;
    error?: string;
    bot?: { app_id?: string };
  };
  const botAppId = botBody.bot?.app_id;
  if (!botRes.ok || !botBody.ok || !botAppId) {
    throw new SlackConnectionError('bot_app_identity', botBody.error ?? 'bots_info_failed');
  }
  if (botAppId !== expectedAppId) {
    throw new SlackConnectionError('app_identity', 'app_token_does_not_match_bot');
  }

  const appRes = await fetchImpl(`${SLACK_API}/apps.connections.open`, {
    method: 'POST',
    headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(SLACK_IDENTITY_TIMEOUT_MS),
  });
  const appBody = (await appRes.json()) as { ok?: boolean; error?: string; url?: string };
  if (!appRes.ok || !appBody.ok || typeof appBody.url !== 'string') {
    throw new SlackConnectionError(
      'app_connection_test',
      appBody.error ?? 'apps_connections_open_failed',
    );
  }

  return {
    botUserId: auth.user_id,
    botId: auth.bot_id,
    teamId: auth.team_id,
    appId: expectedAppId,
  };
}
