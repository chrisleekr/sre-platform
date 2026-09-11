import type { CredentialGetter } from './request-credentials';
import { useCallback, useState } from 'react';
import type {
  AvailableChannelsResponse,
  SaveSlackSurfaceInput,
  SlackChannel,
  SlackChannelsResponse,
  SlackTestResult,
  SurfacesResponse,
  SurfaceSummary,
} from './surfaces';
import { authenticatedFetch } from './authenticatedFetch';
import { checkResponse } from './request-error';
import { useFetchResource } from './useFetchResource';

export interface UseSurfaces {
  surfaces: SurfaceSummary[];
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

const selectSurfaces = (body: unknown): SurfaceSummary[] => (body as SurfacesResponse).surfaces;

/**
 * Fetch the tenant's configured surfaces (the access token authorizes + scopes them). One-shot GET
 * plus a `refetch` so the panel reloads after a save or test flips a surface's state.
 */
export function useSurfaces(opts: {
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
}): UseSurfaces {
  // Bumping the nonce re-runs the load effect; refetch() drives the post-mutation reload.
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  const { data, loading, error } = useFetchResource<SurfaceSummary[]>({
    apiBaseUrl: opts.apiBaseUrl,
    getCredentials: opts.getCredentials,
    path: '/surfaces',
    initial: [],
    select: selectSurfaces,
    nonce,
  });
  return { surfaces: data, loading, error, refetch };
}

/**
 * Upsert the Slack surface. Secrets are write-only: `appToken`/`botToken` are sent only when the
 * operator entered a new value, and the API never returns them. The wizard saves before testing so
 * the probe verifies the just-stored credential.
 */
export async function saveSlackSurface(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  input: SaveSlackSurfaceInput,
): Promise<void> {
  const res = await authenticatedFetch(`${apiBaseUrl}/surfaces/slack`, getCredentials, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  await checkResponse(res, 'Slack connection could not be saved. Retry.');
}

export async function disconnectSlackSurface(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
): Promise<void> {
  const res = await authenticatedFetch(`${apiBaseUrl}/surfaces/slack`, getCredentials, {
    method: 'DELETE',
  });
  await checkResponse(res, 'Slack could not be disconnected. Refresh and retry.');
}

/** Validate the saved bot/app tokens and shared Slack app identity. A warning is advisory only. */
export async function testSlackSurface(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
): Promise<SlackTestResult> {
  const res = await authenticatedFetch(`${apiBaseUrl}/surfaces/slack/test`, getCredentials, {
    method: 'POST',
  });
  await checkResponse(res, 'Slack verification could not run. Retry.');
  return (await res.json()) as SlackTestResult;
}

/** List the channels the bot can be subscribed to for inbound events. Throws on any non-2xx. */
export async function listChannels(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
): Promise<SlackChannel[]> {
  const res = await authenticatedFetch(`${apiBaseUrl}/surfaces/slack/channels`, getCredentials);
  await checkResponse(res, 'Channels could not be loaded. Retry.');
  const body = (await res.json()) as SlackChannelsResponse;
  return body.channels;
}

/**
 * Enable/disable inbound events for a single channel. `channel` is always the Slack ID; `name` rides
 * along so a rename self-heals on the next toggle. Throws on any non-2xx.
 */
export async function toggleChannel(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  channel: string,
  enabled: boolean,
  name?: string,
): Promise<void> {
  const res = await authenticatedFetch(
    `${apiBaseUrl}/surfaces/slack/channels/${encodeURIComponent(channel)}`,
    getCredentials,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled, name }),
    },
  );
  await checkResponse(res, 'The channel subscription could not be updated. Refresh and retry.');
}

/**
 * The channels Slack itself reports the bot can see — the pick-list source. The error is
 * surfaced verbatim (it names the missing scope) rather than degrading to an empty list, which would
 * read as "this workspace has no channels".
 */
export async function listAvailableChannels(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
): Promise<AvailableChannelsResponse> {
  const res = await authenticatedFetch(
    `${apiBaseUrl}/surfaces/slack/available-channels`,
    getCredentials,
  );
  await checkResponse(res, 'Slack channel discovery could not complete. Retry.');
  const body = (await res.json()) as AvailableChannelsResponse;
  // `truncated` rides along with the list: the caller cannot tell a capped list from a complete
  // one by looking at it, so the flag must survive the boundary.
  return { channels: body.channels, truncated: body.truncated === true };
}
