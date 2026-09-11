const messages = {
  authentication: 'GitLab rejected the token. Check its expiry and whether it has been revoked.',
  permission: 'GitLab denied access. Check read_api scope and Reporter access to the group.',
  not_found:
    'GitLab could not find an accessible group or project. Check the full group path and token membership. Personal namespaces are not groups.',
  rate_limit: 'GitLab is rate limiting discovery. Wait before trying again.',
  unavailable: 'GitLab is temporarily unavailable. Try again shortly.',
  timeout:
    'GitLab did not respond in time. Check connectivity from the SRE Platform API, then retry.',
  network:
    'The SRE Platform API could not connect to GitLab. Check DNS, TLS certificates, and network access.',
  response_limit:
    'The GitLab catalog or response exceeds the discovery safety limit. Choose a smaller operational group.',
  unsafe_url:
    'The GitLab address is blocked by the connector URL policy. Use a permitted HTTPS instance address.',
  invalid_response:
    'GitLab returned an unexpected response. Check the instance URL and any proxy in front of GitLab.',
  unknown:
    'GitLab discovery could not complete. Retry, or ask your administrator to check the diagnostic reference.',
};

/** Credential-free failure details safe to return to a workspace administrator. */
export class GitLabDiscoveryError extends Error {
  constructor(
    readonly code: keyof typeof messages,
    readonly stage: 'connection' | 'group' | 'projects' | 'version',
    readonly upstreamStatus?: number,
  ) {
    super(messages[code]);
  }
}

/**
 * Converts discovery failures to safe diagnostics without provider response bodies or credentials.
 * @param error - Failure raised while reading the GitLab catalog.
 */
export function gitLabDiscoveryFailure(error: unknown): GitLabDiscoveryError {
  if (error instanceof GitLabDiscoveryError) return error;
  const message = error instanceof Error ? error.message : '';
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    return new GitLabDiscoveryError('timeout', 'projects');
  if (message.startsWith('gitlab ') && /limit/.test(message))
    return new GitLabDiscoveryError('response_limit', 'projects');
  if (message === 'gitlab connector: invalid group response')
    return new GitLabDiscoveryError('invalid_response', 'group');
  if (message.startsWith('gitlab ') && /response|pagination/.test(message))
    return new GitLabDiscoveryError('invalid_response', 'projects');
  if (error instanceof SyntaxError) return new GitLabDiscoveryError('invalid_response', 'projects');
  return new GitLabDiscoveryError('unknown', 'connection');
}

/**
 * Wraps read-only discovery requests with a shared budget of two transient retries.
 * @param fetchImpl - Transport used for GitLab GET requests.
 */
export function discoveryFetch(fetchImpl: typeof fetch): typeof fetch {
  let retries = 2;
  return (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const stage = path.endsWith('/version')
      ? 'version'
      : path.endsWith('/projects')
        ? 'projects'
        : 'group';
    for (;;) {
      let failure: GitLabDiscoveryError;
      let delay = 250;
      try {
        const response = await fetchImpl(input, { ...init, signal: AbortSignal.timeout(8000) });
        if (response.ok) return response;
        const status = response.status;
        const code =
          status === 401
            ? 'authentication'
            : status === 403
              ? 'permission'
              : status === 404
                ? 'not_found'
                : status === 429
                  ? 'rate_limit'
                  : status >= 500
                    ? 'unavailable'
                    : 'invalid_response';
        failure = new GitLabDiscoveryError(code, stage, status);
        const retryAfter = response.headers.get('retry-after');
        if (retryAfter !== null) {
          const seconds = Number(retryAfter);
          delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
          if (!Number.isFinite(delay)) delay = Infinity;
          delay = Math.max(250, delay);
        } else if (status === 429) delay = Infinity;
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        failure = new GitLabDiscoveryError(
          error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
            ? 'timeout'
            : 'network',
          stage,
        );
      }
      const transient = ['unavailable', 'timeout', 'network', 'rate_limit'].includes(failure.code);
      if (!transient || retries === 0 || delay > 2000 || stage === 'version') throw failure;
      retries -= 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }) as typeof fetch;
}
