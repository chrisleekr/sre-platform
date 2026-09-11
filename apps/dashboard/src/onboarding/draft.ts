import type { SignInRetry } from '../lib/application-session';

export interface WorkspaceDraft {
  requestedName: string;
  slug: string;
}

const KEY = 'sre-platform.workspace-draft';
const SETUP_KEY = 'sre-platform.workspace-sign-in';

/** Saves the created setup separately from editable registration inputs.
 * @param slug - Draft address that owns this continuation.
 * @param retry - Non-secret routing to the already-created setup.
 */
export function saveWorkspaceSignIn(slug: string, retry: SignInRetry): void {
  try {
    sessionStorage.setItem(
      SETUP_KEY,
      JSON.stringify({
        slug,
        retry: {
          providerId: retry.providerId,
          foundingId: retry.foundingId,
          returnTo: retry.returnTo,
        },
      }),
    );
  } catch {
    // An in-memory continuation still permits retry when tab storage is unavailable.
  }
}

/** Restores a continuation only for the matching workspace draft.
 * @param slug - Current draft address, never inferred from an unrelated sign-in attempt.
 */
export function readWorkspaceSignIn(slug: string): { slug: string; retry: SignInRetry } | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(SETUP_KEY) ?? 'null');
    if (
      value?.slug !== slug ||
      typeof value.retry?.providerId !== 'string' ||
      typeof value.retry?.foundingId !== 'string'
    )
      return null;
    return {
      slug,
      retry: {
        providerId: value.retry.providerId,
        foundingId: value.retry.foundingId,
        returnTo: '/get-started',
      },
    };
  } catch {
    return null;
  }
}

export function saveWorkspaceDraft(draft: WorkspaceDraft): void {
  sessionStorage.setItem(KEY, JSON.stringify(draft));
}

export function readWorkspaceDraft(): WorkspaceDraft | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as WorkspaceDraft | null;
    return value && typeof value.requestedName === 'string' && typeof value.slug === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}

export function clearWorkspaceDraft(): void {
  try {
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(SETUP_KEY);
  } catch {
    // Draft cleanup must not prevent credential cleanup or recovery navigation.
  }
}
