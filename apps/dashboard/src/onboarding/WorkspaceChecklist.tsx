import { Link } from 'react-router-dom';
import { useSession } from '../auth';
import { config } from '../config';
import { invalidateMe } from '../lib/me-store';
import { credentialHeaders } from '../lib/request-credentials';
import { productPath } from '../lib/routes';
import { sessionFetch } from '../lib/session-fetch';
import { primaryButton } from './shared';

interface Checklist {
  workspaceCreated?: boolean;
  domainVerified?: boolean;
  observabilityConnected?: boolean;
  slackConnected?: boolean;
}

export function workspaceChecklistComplete(checklist: Checklist): boolean {
  return Boolean(
    checklist.workspaceCreated &&
    checklist.domainVerified &&
    checklist.observabilityConnected &&
    checklist.slackConnected,
  );
}

/** Product activation checklist shown on the workspace home. */
export function WorkspaceChecklist({
  checklist,
  domainId,
  onRefresh,
}: {
  checklist: Checklist;
  domainId?: string;
  onRefresh?: () => void;
}) {
  const session = useSession();
  const items = [
    ['Create your workspace', checklist.workspaceCreated, productPath()],
    [
      'Verify your domain',
      checklist.domainVerified,
      domainId ? productPath(`settings/domains/${domainId}`) : productPath('settings'),
    ],
    [
      'Connect an observability source',
      checklist.observabilityConnected,
      productPath('connectors'),
    ],
    ['Connect Slack', checklist.slackConnected, productPath('surfaces')],
  ] as const;
  const dismiss = async (): Promise<void> => {
    const token = await session.getCredentials();
    const response = await sessionFetch(`${config.apiBaseUrl}/me/welcome/dismiss`, {
      method: 'POST',
      headers: {
        ...credentialHeaders(token),
        ...(session.foundingId ? { 'x-onboarding-founding-id': session.foundingId } : {}),
      },
    });
    if (!response.ok) return;
    if (onRefresh) onRefresh();
    else invalidateMe();
  };
  return (
    <section aria-labelledby="workspace-checklist-title">
      <h2 id="workspace-checklist-title" className="text-xl font-medium">
        Finish setting up your workspace
      </h2>
      <ul className="mt-4 space-y-3">
        {items.map(([label, done, href]) => (
          <li
            key={label}
            className="flex items-center justify-between rounded-lg border border-line p-3"
          >
            <span>
              {done ? '✓ ' : ''}
              {label}
            </span>
            {!done && (
              <Link className="font-semibold text-accent" to={href}>
                {label === 'Verify your domain'
                  ? 'Verify domain'
                  : label === 'Connect an observability source'
                    ? 'Connect a source'
                    : label === 'Connect Slack'
                      ? 'Connect Slack'
                      : 'Open workspace'}
              </Link>
            )}
          </li>
        ))}
      </ul>
      <button type="button" className={`${primaryButton} mt-5`} onClick={() => void dismiss()}>
        Dismiss checklist
      </button>
    </section>
  );
}
