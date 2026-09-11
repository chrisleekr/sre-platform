import { requestErrorMessage } from '../lib/request-error';
import { useState } from 'react';
import { useSession } from '../auth';
import { InlineAlert } from '../components/PageState';
import { adminRequest } from './api';
import { AdminPage } from './AdminPage';
import { useAdminData } from './useAdminData';
import { BackchannelLogoutSetting } from '../components/BackchannelLogoutSetting';
import {
  ScimProvisioningSetting,
  type ScimPolicyInput,
} from '../components/ScimProvisioningSetting';

interface Provider {
  id: string;
  displayName: string;
  kind: 'oidc' | 'local';
  issuer: string;
  jwksUri: string;
  audience: string;
  browserClientId: string | null;
  authorizationEndpoint: string | null;
  tokenEndpoint: string | null;
  backchannelLogout: boolean;
  backchannelLogoutTypRequired: boolean;
  scimEnabled: boolean;
  scimTokenCreatedAt: string | null;
  scimTokenExpiresAt: string | null;
  requireProvisioned: boolean;
  scimIdentityAttribute: 'externalId' | 'userName';
  clientAuthentication: 'none' | 'client_secret_post' | 'client_secret_basic';
  emailClaim: string;
  tenantClaim: string | null;
  subjectClaim: string;
  status: string;
}

/** Edits only installation-scoped identity providers and refreshes verifier state on save. */
export function ProvidersPage() {
  const { getCredentials } = useSession();
  const query = useAdminData(() =>
    adminRequest<{ providers: Provider[] }>(getCredentials, '/providers'),
  );
  const [drafts, setDrafts] = useState<Record<string, Partial<Provider>>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const save = async (provider: Provider) => {
    setBusy(provider.id);
    setError(undefined);
    try {
      await adminRequest(getCredentials, `/providers/${provider.id}`, {
        method: 'PUT',
        body: {
          ...drafts[provider.id],
          ...(secrets[provider.id] ? { clientSecret: secrets[provider.id] } : {}),
        },
      });
      setDrafts((current) => ({ ...current, [provider.id]: {} }));
      setSecrets((current) => ({ ...current, [provider.id]: '' }));
      await query.refresh();
    } catch (cause) {
      setError(requestErrorMessage(cause, 'Identity provider update failed.'));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <AdminPage
      title="Identity providers"
      description="Installation sign-in configuration. Workspace-owned directories are managed by their owners."
      loading={query.loading}
      error={query.data ? undefined : query.error}
      onRetry={() => void query.refresh()}
    >
      {query.data && query.error && <InlineAlert message={query.error} />}
      {error && <InlineAlert message={error} />}
      <div className="grid gap-4">
        {query.data?.providers.length === 0 && (
          <p className="rounded-xl border border-line bg-surface p-5 text-sm text-ink-muted">
            No installation identity provider is configured. Add the staff sign-in provider during
            deployment before granting platform-administrator access.
          </p>
        )}
        {query.data?.providers.map((provider) => {
          const draft = { ...provider, ...drafts[provider.id] };
          const update = (patch: Partial<Provider>) =>
            setDrafts((current) => ({
              ...current,
              [provider.id]: { ...current[provider.id], ...patch },
            }));
          return (
            <article
              key={provider.id}
              className="rounded-xl border border-line bg-surface p-5 shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-bold">{provider.displayName}</h2>
                <span className="rounded-full bg-surface-subtle px-2.5 py-1 text-xs font-semibold uppercase">
                  {provider.status}
                </span>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {(
                  [
                    ['Display name', 'displayName'],
                    ['Issuer', 'issuer'],
                    ['JWKS URL', 'jwksUri'],
                    ['Authorization URL', 'authorizationEndpoint'],
                    ['Token URL', 'tokenEndpoint'],
                    ['Browser client ID', 'browserClientId'],
                    ['Legacy API bearer audience', 'audience'],
                    ['Email claim', 'emailClaim'],
                    ['Tenant claim', 'tenantClaim'],
                    ['Subject claim', 'subjectClaim'],
                  ] as const
                ).map(([label, key]) => (
                  <label key={key} className="grid gap-1 text-sm font-medium">
                    {label}
                    <input
                      value={draft[key] ?? ''}
                      onChange={(event) =>
                        update({ [key]: event.target.value || (key === 'tenantClaim' ? null : '') })
                      }
                      className="min-w-0 rounded-lg border border-line-strong bg-canvas px-3 py-2 font-mono text-sm"
                    />
                  </label>
                ))}
                <label className="grid gap-1 text-sm font-medium">
                  Application authentication
                  <select
                    className="rounded-lg border border-line-strong bg-canvas px-3 py-2"
                    value={draft.clientAuthentication ?? 'none'}
                    onChange={(event) =>
                      update({
                        clientAuthentication: event.target
                          .value as Provider['clientAuthentication'],
                      })
                    }
                  >
                    <option value="client_secret_post">Web application with client secret</option>
                    <option value="client_secret_basic">Web application with HTTP Basic</option>
                    <option value="none">Public client without a secret</option>
                  </select>
                </label>
                {draft.clientAuthentication !== 'none' && (
                  <label className="grid gap-1 text-sm font-medium">
                    New client secret
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={secrets[provider.id] ?? ''}
                      onChange={(event) =>
                        setSecrets((current) => ({ ...current, [provider.id]: event.target.value }))
                      }
                      className="rounded-lg border border-line-strong bg-canvas px-3 py-2"
                    />
                    <span className="text-xs font-normal text-ink-muted">
                      Write-only and encrypted. Leave blank to keep the configured secret.
                    </span>
                  </label>
                )}
                {draft.kind === 'oidc' && draft.browserClientId && (
                  <BackchannelLogoutSetting
                    providerId={provider.id}
                    enabled={draft.backchannelLogout}
                    typRequired={draft.backchannelLogoutTypRequired}
                    disabled={Boolean(busy)}
                    onChange={(enabled) => update({ backchannelLogout: enabled })}
                    onTypRequiredChange={(typRequired) =>
                      update({ backchannelLogoutTypRequired: typRequired })
                    }
                  />
                )}
                {draft.kind === 'oidc' && draft.browserClientId && (
                  <ScimProvisioningSetting
                    providerId={provider.id}
                    subjectClaim={draft.subjectClaim}
                    enabled={provider.scimEnabled}
                    tokenCreatedAt={provider.scimTokenCreatedAt}
                    tokenExpiresAt={provider.scimTokenExpiresAt}
                    requireProvisioned={provider.requireProvisioned}
                    identityAttribute={provider.scimIdentityAttribute}
                    disabled={Boolean(busy)}
                    save={async (input: ScimPolicyInput, rotateCredential: boolean) => {
                      const result = await adminRequest<{ token?: string }>(
                        getCredentials,
                        `/providers/${provider.id}/scim${rotateCredential ? '/credential' : ''}`,
                        { method: rotateCredential ? 'POST' : 'PUT', body: input },
                      );
                      await query.refresh();
                      return result;
                    }}
                    loadAccounts={(startIndex, count) =>
                      adminRequest(
                        getCredentials,
                        `/providers/${provider.id}/scim/accounts?startIndex=${startIndex}&count=${count}`,
                      )
                    }
                  />
                )}
                <label className="grid gap-1 text-sm font-medium">
                  Status
                  <select
                    value={draft.status}
                    onChange={(event) => update({ status: event.target.value })}
                    className="rounded-lg border border-line-strong bg-canvas px-3 py-2"
                  >
                    <option value="active">Active</option>
                    <option value="disabled">Disabled</option>
                    <option value="failed">Failed</option>
                    <option value="pending_verification">Pending verification</option>
                  </select>
                </label>
              </div>
              <button
                type="button"
                disabled={
                  Boolean(busy) ||
                  (Object.keys(drafts[provider.id] ?? {}).length === 0 && !secrets[provider.id])
                }
                onClick={() => void save(provider)}
                className="mt-4 rounded-lg bg-strong px-4 py-2 text-sm font-semibold text-on-strong disabled:opacity-50"
              >
                Save provider
              </button>
            </article>
          );
        })}
      </div>
    </AdminPage>
  );
}
