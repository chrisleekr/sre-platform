import { requestErrorMessage } from '../lib/request-error';
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../auth';
import { useMe } from '../lib/me-store';
import {
  workspaceSettingsRequest,
  type WorkspaceMethod,
  type WorkspaceSettingsData,
} from '../lib/workspace-settings';
import { SignInMethodSetup, type SignInMethodInput } from '../onboarding/SignInMethodSetup';
import { PageHeader } from './PageHeader';
import { InlineAlert, StatePanel } from './PageState';
import { WorkspaceSettingsNavigation } from './WorkspaceSettingsNavigation';
import { WorkspaceMutationConfirmation } from './WorkspaceMutationConfirmation';
import { BackchannelLogoutSetting } from './BackchannelLogoutSetting';
import { ScimProvisioningSetting, type ScimPolicyInput } from './ScimProvisioningSetting';
import { DomainDnsVerification } from './DomainDnsVerification';
/** Workspace sign-in methods, trusted domains, and directory-only access policy. */
export function AuthenticationSettingsPage() {
  const session = useSession();
  const me = useMe(session.getCredentials, session.status === 'authenticated', session.sessionKey);
  const [data, setData] = useState<WorkspaceSettingsData>();
  const [addingMethod, setAddingMethod] = useState(false);
  const [domain, setDomain] = useState('');
  const [domainMethodId, setDomainMethodId] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmation, setConfirmation] = useState<{
    title: string;
    path: string;
    method: string;
  }>();
  const owner = me.data?.tenant?.role === 'owner';
  const canVerifyDns =
    owner ||
    Boolean(
      me.data?.user?.isPlatformAdmin &&
      me.data.tenant?.role === 'admin' &&
      me.data.tenant.impersonation,
    );
  const load = useCallback(async () => {
    setError(undefined);
    try {
      const next = await workspaceSettingsRequest<WorkspaceSettingsData>(
        session.getCredentials,
        '/settings',
      );
      setData(next);
      setDomainMethodId(
        (current) => current || next.methods.find((method) => method.scope === 'tenant')?.id || '',
      );
    } catch (cause) {
      setError(requestErrorMessage(cause, 'Authentication settings are unavailable.'));
    }
  }, [session.getCredentials]);
  useEffect(() => void load(), [load]);

  async function run(key: string, operation: () => Promise<unknown>) {
    setBusy(key);
    setError(undefined);
    try {
      await operation();
      await load();
    } catch (cause) {
      setError(requestErrorMessage(cause, 'The change could not be saved.'));
    } finally {
      setBusy(undefined);
    }
  }

  async function addMethod(input: SignInMethodInput) {
    await workspaceSettingsRequest(session.getCredentials, '/providers', {
      method: 'POST',
      body: { ...input, sortOrder: (data?.methods.length ?? 0) * 10 },
    });
    setAddingMethod(false);
    await load();
  }

  async function move(method: WorkspaceMethod, direction: -1 | 1) {
    if (!data) return;
    const ordered = [...data.methods].sort((left, right) => left.sortOrder - right.sortOrder);
    const index = ordered.findIndex((candidate) => candidate.id === method.id);
    const other = ordered[index + direction];
    if (!other) return;
    await run(`move:${method.id}`, async () => {
      const providerIds = ordered.map((candidate) => candidate.id);
      [providerIds[index], providerIds[index + direction]] = [
        providerIds[index + direction]!,
        providerIds[index]!,
      ];
      await workspaceSettingsRequest(session.getCredentials, '/providers/order', {
        method: 'PUT',
        body: { providerIds },
      });
    });
  }

  return (
    <section>
      <PageHeader
        title="Authentication"
        description="Control how people sign in and which work email domains are trusted. Changes never remove the final usable sign-in path."
        action={
          owner ? (
            <button
              type="button"
              onClick={() => setAddingMethod((open) => !open)}
              className="sre-action sre-action-primary"
            >
              {addingMethod ? 'Cancel setup' : 'Add sign-in method'}
            </button>
          ) : undefined
        }
      />
      <WorkspaceSettingsNavigation />
      {confirmation && data && (
        <WorkspaceMutationConfirmation
          key={confirmation.path}
          title={confirmation.title}
          slug={data.workspace.slug}
          busy={Boolean(busy)}
          onCancel={() => setConfirmation(undefined)}
          onConfirm={() =>
            void run(confirmation.path, async () => {
              await workspaceSettingsRequest(session.getCredentials, confirmation.path, {
                method: confirmation.method,
              });
              setConfirmation(undefined);
            })
          }
        />
      )}
      {error && <InlineAlert message={error} onRetry={data ? undefined : load} />}
      {!data && !error && (
        <StatePanel state="loading" title="Loading authentication settings…" skeleton="settings" />
      )}
      {data && (
        <div className="space-y-5">
          {addingMethod && owner && (
            <section className="rounded-xl border border-focus bg-surface p-5 sm:p-6">
              <div className="mb-5 border-b border-line pb-4">
                <h2 className="font-instrument text-xl font-medium text-ink">
                  Add a sign-in method
                </h2>
                <p className="mt-1 text-sm leading-6 text-ink-muted">
                  The method stays unavailable until its work email domain is verified.
                </p>
              </div>
              <SignInMethodSetup
                submitLabel="Save sign-in method"
                onSubmit={addMethod}
                nextDescription="Save the method, then copy its DNS TXT record from Work email domains below. The method becomes available after domain verification succeeds."
              />
            </section>
          )}

          <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="font-instrument text-lg font-medium text-ink">Sign-in methods</h2>
                <p className="mt-1 text-sm leading-6 text-ink-muted">
                  Order controls how choices appear on the workspace sign-in page.
                </p>
              </div>
              <span className="text-sm text-ink-muted">{data.methods.length} configured</span>
            </div>
            <div className="mt-4 divide-y divide-line rounded-xl border border-line">
              {data.methods.map((method, index) => (
                <article
                  key={method.id}
                  className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium text-ink">{method.displayName}</h3>
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${method.status === 'active' ? 'bg-success-soft text-success' : method.status === 'pending_verification' ? 'bg-warning-soft text-warning' : 'bg-surface-subtle text-ink-muted'}`}
                      >
                        {method.status === 'pending_verification'
                          ? 'Awaiting domain verification'
                          : method.status}
                      </span>
                      {method.scope === 'installation' && (
                        <span className="rounded-full bg-info-soft px-2 py-0.5 text-xs font-semibold text-info">
                          Managed by platform
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-xs text-ink-muted">{method.issuer}</p>
                  </div>
                  {owner && method.scope === 'tenant' && (
                    <div className="flex flex-wrap gap-2 lg:justify-end">
                      <button
                        type="button"
                        aria-label={`Move ${method.displayName} earlier`}
                        disabled={index === 0 || Boolean(busy)}
                        onClick={() => void move(method, -1)}
                        className="sre-action text-xs"
                      >
                        Earlier
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${method.displayName} later`}
                        disabled={index === data.methods.length - 1 || Boolean(busy)}
                        onClick={() => void move(method, 1)}
                        className="sre-action text-xs"
                      >
                        Later
                      </button>
                      {method.status === 'active' ? (
                        <button
                          type="button"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            setConfirmation({
                              title: `Disable ${method.displayName}?`,
                              path: `/providers/${method.id}/disable`,
                              method: 'POST',
                            })
                          }
                          className="rounded-md border border-warning-line px-3 py-2 text-xs font-semibold text-warning disabled:opacity-40"
                        >
                          Disable
                        </button>
                      ) : method.status === 'disabled' ? (
                        <button
                          type="button"
                          disabled={Boolean(busy)}
                          onClick={() =>
                            void run(`enable:${method.id}`, () =>
                              workspaceSettingsRequest(
                                session.getCredentials,
                                `/providers/${method.id}/enable`,
                                { method: 'POST' },
                              ),
                            )
                          }
                          className="rounded-md border border-success-line px-3 py-2 text-xs font-semibold text-success disabled:opacity-40"
                        >
                          Enable
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          setConfirmation({
                            title: `Delete ${method.displayName}?`,
                            path: `/providers/${method.id}`,
                            method: 'DELETE',
                          })
                        }
                        className="rounded-md border border-critical-line px-3 py-2 text-xs font-semibold text-critical disabled:opacity-40"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                  {owner &&
                    method.scope === 'tenant' &&
                    method.kind === 'oidc' &&
                    method.browserClientId && (
                      <div className="lg:col-span-2">
                        <BackchannelLogoutSetting
                          providerId={method.id}
                          enabled={method.backchannelLogout}
                          typRequired={method.backchannelLogoutTypRequired}
                          disabled={Boolean(busy)}
                          onChange={(enabled) =>
                            void run(`backchannel:${method.id}`, () =>
                              workspaceSettingsRequest(
                                session.getCredentials,
                                `/providers/${method.id}/backchannel-logout`,
                                {
                                  method: 'PUT',
                                  body: {
                                    enabled,
                                    typRequired: method.backchannelLogoutTypRequired,
                                  },
                                },
                              ),
                            )
                          }
                          onTypRequiredChange={(typRequired) =>
                            void run(`backchannel:${method.id}`, () =>
                              workspaceSettingsRequest(
                                session.getCredentials,
                                `/providers/${method.id}/backchannel-logout`,
                                {
                                  method: 'PUT',
                                  body: { enabled: method.backchannelLogout, typRequired },
                                },
                              ),
                            )
                          }
                        />
                      </div>
                    )}
                  {owner &&
                    method.scope === 'tenant' &&
                    method.kind === 'oidc' &&
                    method.browserClientId && (
                      <div className="lg:col-span-2">
                        <ScimProvisioningSetting
                          providerId={method.id}
                          subjectClaim={method.subjectClaim}
                          enabled={method.scimEnabled}
                          tokenCreatedAt={method.scimTokenCreatedAt}
                          tokenExpiresAt={method.scimTokenExpiresAt}
                          requireProvisioned={method.requireProvisioned}
                          identityAttribute={method.scimIdentityAttribute}
                          disabled={Boolean(busy)}
                          save={async (input: ScimPolicyInput, rotateCredential: boolean) => {
                            const result = await workspaceSettingsRequest<{ token?: string }>(
                              session.getCredentials,
                              `/providers/${method.id}/scim${rotateCredential ? '/credential' : ''}`,
                              { method: rotateCredential ? 'POST' : 'PUT', body: input },
                            );
                            await load();
                            return result;
                          }}
                          loadAccounts={(startIndex, count) =>
                            workspaceSettingsRequest(
                              session.getCredentials,
                              `/providers/${method.id}/scim/accounts?startIndex=${startIndex}&count=${count}`,
                            )
                          }
                        />
                      </div>
                    )}
                </article>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
            <h2 className="font-instrument text-lg font-medium text-ink">Work email domains</h2>
            <p className="mt-1 text-sm leading-6 text-ink-muted">
              A DNS TXT record proves your workspace controls each domain.
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {data.domains.map((entry) => (
                <article key={entry.id} className="rounded-lg border border-line bg-canvas p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="truncate font-medium text-ink">{entry.domain}</h3>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-semibold ${entry.status === 'verified' ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning'}`}
                    >
                      {entry.status}
                    </span>
                  </div>
                  {entry.status === 'pending' && entry.challenge && (
                    <div className="mt-3 space-y-1 text-xs text-ink-muted">
                      <p>
                        Host: <code className="text-ink">_sre-platform.{entry.domain}</code>
                      </p>
                      <p className="break-all">
                        Value: <code className="text-ink">{entry.challenge}</code>
                      </p>
                    </div>
                  )}
                  <DomainDnsVerification
                    domain={entry}
                    canVerify={canVerifyDns}
                    platformManaged={
                      !data.methods.some(
                        (method) => method.id === entry.providerId && method.scope === 'tenant',
                      )
                    }
                    busy={Boolean(busy)}
                    checking={busy === `check:${entry.id}`}
                    onCheck={async () => {
                      setBusy(`check:${entry.id}`);
                      try {
                        const result = await workspaceSettingsRequest<{
                          status: 'pending' | 'verified' | 'expired' | 'conflict';
                        }>(session.getCredentials, `/domains/${entry.id}/check`, {
                          method: 'POST',
                        });
                        await load();
                        return result;
                      } finally {
                        setBusy(undefined);
                      }
                    }}
                  />
                  {owner &&
                    data.methods.some(
                      (method) => method.id === entry.providerId && method.scope === 'tenant',
                    ) && (
                      <button
                        type="button"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          setConfirmation({
                            title: `Delete ${entry.domain}?`,
                            path: `/domains/${entry.id}`,
                            method: 'DELETE',
                          })
                        }
                        className="mt-4 rounded-md border border-critical-line px-3 py-2 text-xs font-semibold text-critical disabled:opacity-40"
                      >
                        Delete
                      </button>
                    )}
                </article>
              ))}
            </div>
            {owner && data.methods.some((method) => method.scope === 'tenant') && (
              <form
                className="mt-5 grid gap-3 rounded-lg border border-line bg-surface-subtle p-4 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(12rem,1fr)_auto] sm:items-end"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run('add-domain', async () => {
                    await workspaceSettingsRequest(session.getCredentials, '/domains', {
                      method: 'POST',
                      body: { providerId: domainMethodId, domain },
                    });
                    setDomain('');
                  });
                }}
              >
                <label className="text-sm font-medium">
                  Sign-in method
                  <select
                    value={domainMethodId}
                    onChange={(event) => setDomainMethodId(event.target.value)}
                    className="sre-field mt-1 block w-full bg-canvas"
                  >
                    {data.methods
                      .filter((method) => method.scope === 'tenant')
                      .map((method) => (
                        <option key={method.id} value={method.id}>
                          {method.displayName}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="text-sm font-medium">
                  Domain
                  <input
                    required
                    value={domain}
                    onChange={(event) => setDomain(event.target.value)}
                    placeholder="example.com"
                    className="sre-field mt-1 block w-full bg-canvas"
                  />
                </label>
                <button
                  type="submit"
                  disabled={Boolean(busy) || !domain.trim() || !domainMethodId}
                  className="sre-action"
                >
                  Add domain
                </button>
              </form>
            )}
          </section>

          <section className="rounded-xl border border-line bg-surface p-5 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="max-w-3xl">
                <h2 className="font-instrument text-lg font-medium text-ink">
                  Require the workspace directory
                </h2>
                <p className="mt-1 text-sm leading-6 text-ink-muted">
                  When enabled, personal or platform-wide accounts cannot enter this workspace even
                  if they previously had access. Sign in through a workspace-owned method before
                  enabling it.
                </p>
              </div>
              <label className="flex min-h-11 shrink-0 items-center gap-3 rounded-lg border border-line px-4 py-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={data.workspace.requireDirectory}
                  disabled={!owner || Boolean(busy)}
                  onChange={(event) =>
                    void run('require-directory', () =>
                      workspaceSettingsRequest(
                        session.getCredentials,
                        '/settings/require-directory',
                        {
                          method: 'PUT',
                          body: { enabled: event.target.checked },
                        },
                      ),
                    )
                  }
                />
                {data.workspace.requireDirectory ? 'Required' : 'Not required'}
              </label>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
