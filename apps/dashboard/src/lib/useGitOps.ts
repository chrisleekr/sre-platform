import type { CredentialGetter } from './request-credentials';
import { useCallback, useState } from 'react';
import type { GitOpsApplication } from './types';
import { useFetchResource } from './useFetchResource';

interface GitOpsBody {
  applications: GitOpsApplication[];
}

const EMPTY: GitOpsBody = { applications: [] };
const selectBody = (body: unknown): GitOpsBody => {
  const value = body as Partial<GitOpsBody>;
  return { applications: Array.isArray(value.applications) ? value.applications : [] };
};

export function useGitOps(opts: { apiBaseUrl: string; getCredentials: CredentialGetter }): {
  applications: GitOpsApplication[];
  loading: boolean;
  error: boolean;
  backgroundError: boolean;
  refetch: () => void;
} {
  const [nonce, setNonce] = useState(0);
  const resource = useFetchResource<GitOpsBody>({
    apiBaseUrl: opts.apiBaseUrl,
    getCredentials: opts.getCredentials,
    path: '/gitops',
    initial: EMPTY,
    select: selectBody,
    pollMs: 30_000,
    nonce,
  });
  const refetch = useCallback(() => setNonce((value) => value + 1), []);
  return {
    applications: resource.data.applications,
    loading: resource.loading,
    error: resource.error,
    backgroundError: resource.backgroundError,
    refetch,
  };
}
