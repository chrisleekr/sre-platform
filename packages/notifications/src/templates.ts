export const NOTIFICATION_KINDS = [
  'founding.approved',
  'founding.rejected',
  'directory.verified',
  'directory.expiring',
  'workspace.require_directory_cleared',
  'workspace.impersonated',
  'workspace.ownership_transferred',
  'invitation.created',
  'account.disabled',
  'account.signed_out',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

interface RenderedNotification {
  title: string;
  text: string;
  href: string;
}

function stringValue(payload: Record<string, unknown>, key: string, fallback: string): string {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function route(app: string, path: string): string {
  return new URL(path, app.endsWith('/') ? app : `${app}/`).href;
}

/**
 * Renders one lifecycle event for both the in-app inbox and plain-text email.
 *
 * @param kind - Stable lifecycle event kind.
 * @param payload - Event-specific display values.
 * @param options - Public app URL and whether email is currently available.
 */
export function renderNotification(
  kind: NotificationKind,
  payload: Record<string, unknown>,
  options: { app: string; emailAvailable: boolean },
): RenderedNotification {
  const workspace = stringValue(payload, 'workspaceName', 'your workspace');
  const domain = stringValue(payload, 'domain', 'your directory domain');
  const reason = stringValue(payload, 'reason', 'No reason was provided.');
  const role = stringValue(payload, 'role', 'member');
  const suffix = ` Updates remain available in the app${options.emailAvailable ? ' and by email' : ''}.`;
  const content: Record<NotificationKind, Omit<RenderedNotification, 'href'>> = {
    'founding.approved': {
      title: 'Workspace approved',
      text: `${workspace} was approved and is ready for setup.${suffix}`,
    },
    'founding.rejected': {
      title: 'Workspace request rejected',
      text: `${workspace} was not approved. ${reason}${suffix}`,
    },
    'directory.verified': {
      title: 'Directory domain verified',
      text: `${domain} is verified for ${workspace}.${suffix}`,
    },
    'directory.expiring': {
      title: 'Directory verification expires soon',
      text: `The verification challenge for ${domain} expires within 24 hours.${suffix}`,
    },
    'workspace.require_directory_cleared': {
      title: 'Directory requirement cleared',
      text: `A platform administrator cleared the directory requirement for ${workspace}.${suffix}`,
    },
    'workspace.impersonated': {
      title: 'Platform support session changed',
      text: `A bounded platform support session for ${workspace} ${stringValue(payload, 'state', 'changed')}.${suffix}`,
    },
    'workspace.ownership_transferred': {
      title: 'Workspace ownership transferred',
      text: `Ownership of ${workspace} changed.${suffix}`,
    },
    'invitation.created': {
      title: 'Workspace invitation',
      text: `You were invited to join ${workspace} as ${role}.${suffix}`,
    },
    'account.disabled': {
      title: 'Account disabled',
      text: `A platform administrator disabled your SRE Platform account. ${reason}${suffix}`,
    },
    'account.signed_out': {
      title: 'Sessions revoked',
      text: `Your SRE Platform sessions were revoked.${suffix}`,
    },
  };
  const path =
    kind === 'invitation.created' || kind.startsWith('founding.')
      ? '/'
      : kind.startsWith('workspace.') || kind.startsWith('directory.')
        ? '/w'
        : '/w/notifications';
  return { ...content[kind], href: route(options.app, path) };
}

/** Renders a safe plain-text email with no remote content or attachments. */
export function renderEmail(
  kind: NotificationKind,
  payload: Record<string, unknown>,
  options: { app: string; emailAvailable: boolean },
): { subject: string; text: string } {
  const rendered = renderNotification(kind, payload, options);
  return {
    subject: `SRE Platform: ${rendered.title}`,
    text: `${rendered.text}\n\nOpen SRE Platform: ${rendered.href}`,
  };
}
