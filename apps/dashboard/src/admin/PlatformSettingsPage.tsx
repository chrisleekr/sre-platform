import { requestErrorMessage } from '../lib/request-error';
import { useEffect, useState } from 'react';
import { useSession } from '../auth';
import { SettingsPanel } from '../components/SettingsPanel';
import { InlineAlert } from '../components/PageState';
import { adminRequest } from './api';
import { AdminPage } from './AdminPage';
import { useAdminData } from './useAdminData';

type Settings = Record<
  | 'REGISTRATION_MODE'
  | 'PRODUCT_NAME'
  | 'PRODUCT_VALUE_LINE'
  | 'TERMS_URL'
  | 'PRIVACY_URL'
  | 'SUPPORT_URL',
  string | null
>;

const FIELDS = [
  ['PRODUCT_NAME', 'Product name'],
  ['PRODUCT_VALUE_LINE', 'Value line'],
  ['TERMS_URL', 'Terms URL'],
  ['PRIVACY_URL', 'Privacy URL'],
  ['SUPPORT_URL', 'Support URL'],
] as const;

/** Configures public onboarding policy and the existing operational platform settings. */
export function PlatformSettingsPage() {
  const { getCredentials } = useSession();
  const query = useAdminData(() =>
    adminRequest<{ settings: Settings }>(getCredentials, '/settings'),
  );
  const [draft, setDraft] = useState<Partial<Settings>>({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (query.data) setDraft(query.data.settings);
  }, [query.data]);

  const save = async (key: keyof Settings, value: string | null) => {
    setBusy(key);
    setError(undefined);
    try {
      await adminRequest(getCredentials, '/settings', { method: 'PUT', body: { key, value } });
      await query.refresh();
    } catch (cause) {
      setError(requestErrorMessage(cause, 'Platform setting update failed.'));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <AdminPage
      title="Platform settings"
      description="Control public onboarding, authentication limits, automation budgets, model runtime, and optional email delivery."
      loading={query.loading}
      error={query.error}
      onRetry={() => void query.refresh()}
    >
      {error && <InlineAlert message={error} />}
      <section className="rounded-xl border border-line bg-surface p-5">
        <h2 className="text-base font-medium">Onboarding and public copy</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="grid gap-1 text-sm font-medium">
            Registration mode
            <select
              value={draft.REGISTRATION_MODE ?? 'approval_required'}
              onChange={(event) =>
                setDraft((current) => ({ ...current, REGISTRATION_MODE: event.target.value }))
              }
              className="sre-field bg-canvas"
            >
              <option value="open">Open</option>
              <option value="approval_required">Approval required</option>
              <option value="closed">Closed</option>
            </select>
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() =>
                void save('REGISTRATION_MODE', draft.REGISTRATION_MODE ?? 'approval_required')
              }
              className="sre-action sre-action-primary mt-1 w-fit"
            >
              Save registration mode
            </button>
          </label>
          {FIELDS.map(([key, label]) => (
            <label key={key} className="grid gap-1 text-sm font-medium">
              {label}
              <input
                value={draft[key] ?? ''}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [key]: event.target.value || (key.endsWith('_URL') ? null : ''),
                  }))
                }
                className="sre-field bg-canvas"
              />
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void save(key, draft[key] ?? null)}
                className="sre-action mt-1 w-fit"
              >
                Save {label.toLowerCase()}
              </button>
            </label>
          ))}
        </div>
      </section>
      <SettingsPanel embedded />
    </AdminPage>
  );
}
