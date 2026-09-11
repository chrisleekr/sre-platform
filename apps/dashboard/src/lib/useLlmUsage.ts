import type { CredentialGetter } from './request-credentials';
import { useCallback, useState } from 'react';
import type { LlmUsageSummary } from '@sre/contracts';
import { useFetchResource } from './useFetchResource';

const EMPTY_USAGE: LlmUsageSummary = {
  from: '',
  to: '',
  invocations: 0,
  succeeded: 0,
  failed: 0,
  unpriced: 0,
  missingUsage: 0,
  configuredCostUsd: 0,
  providerEstimatedCostUsd: null,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  series: [],
  byOperation: [],
  byModel: [],
};

const selectUsage = (body: unknown): LlmUsageSummary => {
  const usage = body as LlmUsageSummary & { series?: LlmUsageSummary['series'] };
  return { ...usage, series: Array.isArray(usage.series) ? usage.series : [] };
};

export function useLlmUsage(opts: {
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
  from: string;
  to: string;
}) {
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((value) => value + 1), []);
  const query = new URLSearchParams({ from: opts.from, to: opts.to });
  const usage = useFetchResource<LlmUsageSummary>({
    apiBaseUrl: opts.apiBaseUrl,
    getCredentials: opts.getCredentials,
    path: `/platform-settings/llm/usage?${query}`,
    initial: EMPTY_USAGE,
    select: selectUsage,
    nonce,
  });

  return {
    usage: usage.data,
    loading: usage.loading,
    error: usage.error,
    errorStatus: usage.errorStatus,
    refetch,
  };
}
