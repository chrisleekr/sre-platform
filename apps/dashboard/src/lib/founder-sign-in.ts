const KEY = 'sre.founder-sign-in';

interface FounderSignIn {
  email: string;
  providerId: string;
  foundingId: string;
  expiresAt: number;
}

/** Remember routing from an authenticated founder session, never credentials or access. */
export function rememberFounderSignIn(value: FounderSignIn | null): void {
  try {
    if (value) sessionStorage.setItem(KEY, JSON.stringify(value));
    else sessionStorage.removeItem(KEY);
  } catch {
    // Workspace links still permit sign-in when browser storage is unavailable.
  }
}

/** An exact email match can resume only this browser's previously authenticated setup. */
export function readFounderSignIn(email: string): FounderSignIn | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    return value &&
      typeof value.email === 'string' &&
      value.email.toLowerCase() === email.trim().toLowerCase() &&
      typeof value.providerId === 'string' &&
      typeof value.foundingId === 'string' &&
      typeof value.expiresAt === 'number' &&
      value.expiresAt > Date.now()
      ? value
      : null;
  } catch {
    return null;
  }
}
