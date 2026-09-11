// Shared Slack Web API GET mechanics. One place builds the URL, rides the bot token on a Bearer
// header (never the URL), parses the JSON body, and normalizes the pagination cursor. CONVENTION-FREE:
// it returns the HTTP status + parsed body and NEVER decides throw-vs-return. Each caller keeps its own
// error convention — surface-config throws a SlackApiError (operator-facing), slack-reader throws a
// generic and wraps the transport error to avoid leaking the token, the poster (POST) returns a result.
import type { FetchLike } from './types';

/** Slack Web API base. The one canonical origin; POST callers (slack.ts, auth.test) share only this. */
export const SLACK_API = 'https://slack.com/api';

export interface SlackGetResult<T> {
  /** HTTP status, so a caller can branch on 429 before it trusts the body. */
  status: number;
  /** res.ok (HTTP 2xx). Slack still reports logical failures with ok:false in a 200 body. */
  ok: boolean;
  /** Parsed JSON body, or undefined when the response carried none (e.g. a bare 429). */
  body: T | undefined;
}

/**
 * Executes one Slack Web API GET while keeping the bot token out of the URL.
 *
 * @param fetchImpl - HTTP implementation used for the Slack request.
 * @param token - Tenant Slack bot token sent as bearer authorization.
 * @param method - Slack Web API method name.
 * @param params - Query parameters accepted by the Slack method.
 * @param opts - Optional request cancellation signal.
 */
export async function slackApiGet<T>(
  fetchImpl: FetchLike,
  token: string,
  method: string,
  params: URLSearchParams,
  opts?: { signal?: AbortSignal },
): Promise<SlackGetResult<T>> {
  const res = await fetchImpl(`${SLACK_API}/${method}?${params.toString()}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });
  let body: T | undefined;
  try {
    body = (await res.json()) as T;
  } catch {
    body = undefined;
  }
  return { status: res.status, ok: res.ok, body };
}

/**
 * Normalizes Slack's optional pagination cursor.
 *
 * @param body - Parsed Slack response carrying optional pagination metadata.
 */
export function nextCursor(
  body: { response_metadata?: { next_cursor?: string } } | undefined,
): string | undefined {
  return body?.response_metadata?.next_cursor || undefined;
}
