export const MESSAGES = {
  genericFailure: 'Something went wrong. Try again.',
  workspaceAddressTaken: 'That workspace address is already taken.',
  publicEmailDomain: 'Use your organisation work email domain.',
  registrationClosed: 'Ask your administrator for an invitation.',
  directoryUnreachable: 'We could not reach that directory. Check the URL and try again.',
  invalidWorkspace: 'Check the workspace details and try again.',
  termsRequired: 'Accept the terms before submitting your request.',
  workspaceNotFound:
    'No active sign-in method is ready for this email. Enter your workspace address, ask your workspace administrator, or set up a new workspace.',
} as const;

/** Maps stable server codes to approved screen copy without exposing implementation errors. */
export function messageForApiCode(code: string | undefined): string {
  if (code === 'workspace_address_taken') return MESSAGES.workspaceAddressTaken;
  if (code === 'public_email_domain') return MESSAGES.publicEmailDomain;
  if (code === 'registration_closed') return MESSAGES.registrationClosed;
  if (code === 'directory_unreachable') return MESSAGES.directoryUnreachable;
  if (code === 'invalid_workspace' || code === 'invalid_workspace_address') {
    return MESSAGES.invalidWorkspace;
  }
  if (code === 'terms_required') return MESSAGES.termsRequired;
  if (code === 'workspace_not_found') return MESSAGES.workspaceNotFound;
  return MESSAGES.genericFailure;
}
