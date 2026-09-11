export type RequestCredential = { kind: 'cookie' } | { kind: 'bearer'; token: string };
export type CredentialGetter = () => Promise<RequestCredential>;
let browserSessionId: string | undefined;

/** Binds requests from this tab to its authenticated session, not a newer cookie from another tab.
 * @param id - Current server-issued session identifier, absent after sign-out.
 */
export function setBrowserSessionId(id?: string): void {
  browserSessionId = id;
}

/** Converts only genuine bearer credentials into an Authorization header.
 * @param credential - Active application cookie mode or explicit bearer credential.
 */
export function credentialHeaders(credential: RequestCredential): Record<string, string> {
  return credential.kind === 'bearer'
    ? { authorization: `Bearer ${credential.token}` }
    : browserSessionId
      ? { 'x-sre-session-id': browserSessionId }
      : {};
}
