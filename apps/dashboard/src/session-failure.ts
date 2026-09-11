export type SessionFailureReason = 'token-unavailable' | 'unauthorized';

const SESSION_RECOVERY_ERROR_CODES = new Set([
  'account_selection_required',
  'consent_required',
  'interaction_required',
  'incompatible_token_response',
  'invalid_client',
  'invalid_grant',
  'invalid_request',
  'invalid_scope',
  'invalid_token',
  'login_required',
  'mfa_required',
  'missing_refresh_token',
  'unauthorized_client',
  'unsupported_grant_type',
]);

let failure: SessionFailureReason | null = null;
const listeners = new Set<() => void>();

/** Returns the current authentication failure for `useSyncExternalStore`. */
export function getSessionFailure(): SessionFailureReason | null {
  return failure;
}

/**
 * Subscribes to authentication failure changes.
 *
 * @param listener - Callback invoked after the failure state changes.
 */
export function subscribeSessionFailure(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Moves the application to session recovery after authentication fails.
 *
 * @param reason - Failure reported by token acquisition or an API response.
 */
export function reportSessionFailure(reason: SessionFailureReason): void {
  if (failure !== null) return;
  failure = reason;
  for (const listener of listeners) listener();
}

/**
 * Reports only token failures that require an interactive sign-in.
 *
 * @param error - Error returned by the OIDC token acquisition path.
 */
export function reportTokenFailure(error: unknown): void {
  if (!error || typeof error !== 'object') return;
  const value = error as { code?: unknown; error?: unknown };
  const code = typeof value.code === 'string' ? value.code : value.error;
  if (typeof code === 'string' && SESSION_RECOVERY_ERROR_CODES.has(code)) {
    reportSessionFailure('token-unavailable');
  }
}

/** Clears the failure after an explicit sign-in or sign-out transition. */
export function clearSessionFailure(): void {
  if (failure === null) return;
  failure = null;
  for (const listener of listeners) listener();
}
