import type { CredentialGetter } from './request-credentials';
import { useState } from 'react';
import { useFetchResource } from './useFetchResource';

interface SlackPermalinkBody {
  permalink: string | null;
}

const EMPTY: SlackPermalinkBody = { permalink: null };

function safeSlackPermalink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const slackHost = url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !slackHost ||
      !url.pathname.startsWith('/archives/')
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

const selectPermalink = (body: unknown): SlackPermalinkBody => ({
  permalink: safeSlackPermalink((body as Partial<SlackPermalinkBody> | null)?.permalink),
});

export function useSlackPermalink(
  incidentId: string,
  opts: { apiBaseUrl: string; getCredentials: CredentialGetter },
): {
  permalink: string | null;
  loading: boolean;
  error: boolean;
  refresh: () => void;
} {
  const [nonce, setNonce] = useState(0);
  const { data, loading, error } = useFetchResource<SlackPermalinkBody>({
    apiBaseUrl: opts.apiBaseUrl,
    getCredentials: opts.getCredentials,
    path: `/incidents/${incidentId}/slack-permalink`,
    initial: EMPTY,
    select: selectPermalink,
    nonce,
  });
  return {
    permalink: data.permalink,
    loading,
    error,
    refresh: () => setNonce((value) => value + 1),
  };
}
