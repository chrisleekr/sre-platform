import { requestErrorMessage } from '../lib/request-error';
import { useEffect, useState } from 'react';
import { absoluteApiUrl, config } from '../config';

export interface ScimPolicyInput {
  enabled: boolean;
  requireProvisioned: boolean;
  identityAttribute: 'externalId' | 'userName';
}

export interface ScimAccount {
  id: string;
  userName: string;
  externalId: string | null;
  active: boolean;
  updatedAt: string;
}

interface Props {
  providerId: string;
  subjectClaim: string;
  enabled: boolean;
  requireProvisioned: boolean;
  identityAttribute: 'externalId' | 'userName';
  tokenCreatedAt: string | null;
  tokenExpiresAt: string | null;
  disabled?: boolean;
  save(input: ScimPolicyInput, rotateCredential: boolean): Promise<{ token?: string }>;
  loadAccounts(
    startIndex: number,
    count: number,
  ): Promise<{
    total: number;
    accounts: ScimAccount[];
  }>;
}

const PAGE_SIZE = 20;

/** Configures provider-scoped SCIM provisioning without retaining its one-time credential. */
export function ScimProvisioningSetting(props: Props) {
  const [required, setRequired] = useState(props.requireProvisioned);
  const [attribute, setAttribute] = useState(props.identityAttribute);
  const [token, setToken] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [startIndex, setStartIndex] = useState(1);
  const [accounts, setAccounts] = useState<{ total: number; accounts: ScimAccount[] }>();
  const [accountsLoading, setAccountsLoading] = useState(props.enabled);
  const endpoint = absoluteApiUrl(
    `/scim/v2/providers/${props.providerId}`,
    config.apiBaseUrl,
    window.location.origin,
  );

  useEffect(() => {
    setRequired(props.requireProvisioned);
    setAttribute(props.identityAttribute);
  }, [props.identityAttribute, props.requireProvisioned]);

  useEffect(() => {
    if (!props.enabled) {
      setAccounts(undefined);
      setAccountsLoading(false);
      return;
    }
    let live = true;
    setAccountsLoading(true);
    setError('');
    void props
      .loadAccounts(startIndex, PAGE_SIZE)
      .then((value) => live && setAccounts(value))
      .catch((cause) => {
        if (live) setError(requestErrorMessage(cause, 'Accounts unavailable.'));
      })
      .finally(() => {
        if (live) setAccountsLoading(false);
      });
    return () => {
      live = false;
    };
  }, [props.enabled, props.loadAccounts, startIndex]);

  async function save(enabled: boolean, rotateCredential: boolean) {
    setBusy(true);
    setError('');
    setCopyStatus('');
    try {
      const result = await props.save(
        { enabled, requireProvisioned: enabled && required, identityAttribute: attribute },
        rotateCredential,
      );
      setToken(result.token ?? '');
      if (!enabled) setAccounts(undefined);
    } catch (cause) {
      setError(requestErrorMessage(cause, 'SCIM settings could not be saved.'));
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string, label: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${label} copied`);
    } catch {
      setCopyStatus('Select and copy the value manually.');
    }
  }

  const expires = props.tokenExpiresAt ? new Date(props.tokenExpiresAt) : null;
  return (
    <section className="rounded-lg border border-line bg-surface-subtle p-4 md:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-semibold text-ink">SCIM 2.0 provisioning</h4>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-semibold ${props.enabled ? 'bg-success-soft text-success' : 'bg-surface text-ink-muted'}`}
            >
              {props.enabled ? 'Enabled' : 'Off'}
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-sm leading-5 text-ink-muted">
            Let this directory create and deactivate accounts. Deactivation ends current access.
          </p>
        </div>
        {!props.enabled && (
          <button
            type="button"
            disabled={props.disabled || busy}
            onClick={() => void save(true, true)}
            className="rounded-md bg-strong px-3 py-2 text-xs font-semibold text-on-strong disabled:opacity-50"
          >
            Enable SCIM
          </button>
        )}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-medium text-ink">
          Match OIDC {props.subjectClaim} to
          <select
            value={attribute}
            disabled={props.disabled || busy}
            onChange={(event) => setAttribute(event.target.value as 'externalId' | 'userName')}
            className="rounded-md border border-line-strong bg-canvas px-3 py-2"
          >
            <option value="externalId">SCIM externalId</option>
            <option value="userName">SCIM userName</option>
          </select>
          <span className="text-xs font-normal text-ink-muted">
            Choose the field your directory maps to the configured OIDC identity claim.
          </span>
        </label>
        <label className="flex items-start gap-3 rounded-md border border-line bg-canvas p-3 text-sm">
          <input
            type="checkbox"
            checked={required}
            disabled={props.disabled || busy}
            onChange={(event) => setRequired(event.target.checked)}
            className="mt-1 size-4 accent-current"
          />
          <span>
            <span className="block font-semibold text-ink">Require a provisioned account</span>
            <span className="mt-0.5 block text-xs leading-5 text-ink-muted">
              People without a safe active SCIM match cannot sign in.
            </span>
          </span>
        </label>
      </div>

      {props.enabled && (
        <div className="mt-4 border-t border-line pt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            SCIM base URL
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 break-all rounded-md bg-canvas px-3 py-2 text-xs text-ink">
              {endpoint}
            </code>
            <button
              type="button"
              onClick={() => void copy(endpoint, 'URL')}
              className="rounded-md border border-line-strong bg-surface px-3 py-2 text-xs font-semibold"
            >
              Copy URL
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-muted">
            Credential{' '}
            {props.tokenCreatedAt
              ? `created ${new Date(props.tokenCreatedAt).toLocaleDateString()}`
              : 'not created'}
            {expires ? ` · expires ${expires.toLocaleDateString()}` : ''}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={props.disabled || busy}
              onClick={() => void save(true, false)}
              className="rounded-md border border-line-strong bg-surface px-3 py-2 text-xs font-semibold disabled:opacity-50"
            >
              Save policy
            </button>
            <button
              type="button"
              disabled={props.disabled || busy}
              onClick={() => void save(true, true)}
              className="rounded-md border border-warning-line px-3 py-2 text-xs font-semibold text-warning disabled:opacity-50"
            >
              Rotate token
            </button>
            <button
              type="button"
              disabled={props.disabled || busy}
              onClick={() => void save(false, false)}
              className="rounded-md border border-critical-line px-3 py-2 text-xs font-semibold text-critical disabled:opacity-50"
            >
              Disable SCIM
            </button>
          </div>
        </div>
      )}

      {token && (
        <div className="mt-4 rounded-md border border-warning-line bg-warning-soft p-3">
          <p className="text-sm font-semibold text-ink">Copy this token now</p>
          <p className="mt-1 text-xs text-ink-muted">It will not be shown again.</p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 break-all rounded-md bg-canvas px-3 py-2 text-xs text-ink">
              {token}
            </code>
            <button
              type="button"
              onClick={() => void copy(token, 'Token')}
              className="rounded-md border border-line-strong bg-surface px-3 py-2 text-xs font-semibold"
            >
              Copy token
            </button>
          </div>
        </div>
      )}
      {copyStatus && <p className="mt-2 text-xs text-ink-muted">{copyStatus}</p>}
      {error && <p className="mt-3 text-sm text-critical">{error}</p>}

      {props.enabled && accountsLoading && (
        <p className="mt-4 border-t border-line pt-4 text-sm text-ink-muted" role="status">
          Loading provisioned accounts…
        </p>
      )}

      {props.enabled && !accountsLoading && accounts && (
        <div className="mt-4 border-t border-line pt-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-ink">Provisioned accounts</p>
            <span className="text-xs text-ink-muted">{accounts.total} current</span>
          </div>
          {accounts.accounts.length ? (
            <div className="mt-2 overflow-x-auto rounded-md border border-line bg-canvas">
              <table className="w-full min-w-[32rem] text-left text-xs">
                <thead className="text-ink-muted">
                  <tr>
                    <th className="px-3 py-2">User</th>
                    <th className="px-3 py-2">External ID</th>
                    <th className="px-3 py-2">State</th>
                    <th className="px-3 py-2">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {accounts.accounts.map((account) => (
                    <tr key={account.id}>
                      <td className="px-3 py-2 font-medium text-ink">{account.userName}</td>
                      <td className="max-w-56 truncate px-3 py-2 text-ink-muted">
                        {account.externalId ?? 'Not set'}
                      </td>
                      <td className="px-3 py-2">{account.active ? 'Active' : 'Deactivated'}</td>
                      <td className="px-3 py-2 text-ink-muted">
                        {new Date(account.updatedAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-2 text-sm text-ink-muted">
              No current accounts have been provisioned.
            </p>
          )}
          {accounts.total > PAGE_SIZE && (
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                disabled={startIndex === 1}
                onClick={() => setStartIndex(Math.max(1, startIndex - PAGE_SIZE))}
                className="rounded-md border border-line-strong px-3 py-2 text-xs font-semibold disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                disabled={startIndex + PAGE_SIZE > accounts.total}
                onClick={() => setStartIndex(startIndex + PAGE_SIZE)}
                className="rounded-md border border-line-strong px-3 py-2 text-xs font-semibold disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
