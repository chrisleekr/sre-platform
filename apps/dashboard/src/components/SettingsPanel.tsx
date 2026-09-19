import type { LlmRuntimeConfig } from '@sre/contracts';
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../auth';
import { config } from '../config';
import { requestErrorMessage } from '../lib/request-error';
import { saveLlmSettings, useLlmSettings } from '../lib/useLlmSettings';
import { savePlatformSetting, usePlatformSettings } from '../lib/usePlatformSettings';
import {
  LlmRuntimeEditor,
  NUMERIC_SETTING_COPY,
  credentialIdentity,
  validPricing,
} from './LlmRuntimeEditor';
import { PageHeader } from './PageHeader';
import { StatePanel } from './PageState';
import { SmtpSettingsCard } from './SmtpSettingsCard';

/**
 * Number-input bounds per setting key. Held as a table rather than as ternary chains at the input
 * so the three attributes for one setting read together; `step: 1` is what marks a setting
 * integer-only. A key absent here renders an unbounded free-form number input.
 *
 * These are the widget's bounds, not the save guard's: `saveNumeric` rejects on its own limits,
 * which deliberately differ where the two serve different purposes (archive accepts 0 to mean
 * disabled, while the input floors at 1 because the checkbox owns that state).
 */
const NUMERIC_INPUT_BOUNDS: Record<string, { min?: number; max?: number; step: 1 | 'any' }> = {
  MAX_TOKEN_LIFETIME_SEC: { min: 300, max: 2_592_000, step: 1 },
  SESSION_IDLE_SECONDS: { min: 300, max: 604_800, step: 1 },
  SESSION_ABSOLUTE_SECONDS: { min: 300, max: 2_592_000, step: 1 },
  INCIDENT_AUTO_ARCHIVE_DAYS: { min: 1, max: 3650, step: 1 },
  RECOVERY_MAX_CHECKS: { min: 1, max: 10, step: 1 },
  EVIDENCE_ROW_LIMIT: { min: 289, max: 10_000, step: 1 },
  EVIDENCE_BUDGET_CHARS: { min: 83, max: 200_000, step: 1 },
  AUTO_INVESTIGATION_TENANT_LIMIT_24H: { min: 0, step: 1 },
  AUTO_INVESTIGATION_MONITOR_LIMIT_24H: { min: 0, step: 1 },
  AUTO_INVESTIGATION_TENANT_COST_LIMIT_USD_24H: { min: 0, step: 'any' },
  AUTO_INVESTIGATION_MONITOR_COST_LIMIT_USD_24H: { min: 0, step: 'any' },
};

export function SettingsPanel({ embedded = false }: { embedded?: boolean } = {}) {
  const { getCredentials } = useSession();
  const numeric = usePlatformSettings({ apiBaseUrl: config.apiBaseUrl, getCredentials });
  const llm = useLlmSettings({ apiBaseUrl: config.apiBaseUrl, getCredentials });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const dirtyKeys = useRef(new Set<string>());
  const previousArchiveDays = useRef<Record<string, number>>({});
  const [llmDraft, setLlmDraft] = useState<LlmRuntimeConfig | null>(null);
  const llmDirty = useRef(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [savingLlm, setSavingLlm] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [invalidKey, setInvalidKey] = useState<string | null>(null);

  useEffect(() => {
    setDrafts((current) =>
      Object.fromEntries(
        numeric.settings.map((setting) => [
          setting.key,
          dirtyKeys.current.has(setting.key)
            ? (current[setting.key] ?? String(setting.value))
            : String(setting.value),
        ]),
      ),
    );
  }, [numeric.settings]);

  useEffect(() => {
    if (llm.settings && !llmDirty.current) setLlmDraft(llm.settings.config);
  }, [llm.settings]);

  const saveNumeric = async (key: string, currentValue: number): Promise<void> => {
    if (savingKey !== null || savingLlm) return;
    const draft = drafts[key] ?? String(currentValue);
    const value = Number(draft);
    const invalidArchiveDays =
      key === 'INCIDENT_AUTO_ARCHIVE_DAYS' &&
      (!Number.isInteger(value) || value < 0 || value > 3_650);
    const invalidRecoveryChecks =
      key === 'RECOVERY_MAX_CHECKS' && (!Number.isInteger(value) || value < 1 || value > 10);
    const invalidEvidenceRowLimit =
      key === 'EVIDENCE_ROW_LIMIT' && (!Number.isInteger(value) || value < 289 || value > 10_000);
    const invalidEvidenceBudget =
      key === 'EVIDENCE_BUDGET_CHARS' &&
      (!Number.isInteger(value) || value < 83 || value > 200_000);
    const invalidTokenLifetime =
      key === 'MAX_TOKEN_LIFETIME_SEC' &&
      (!Number.isInteger(value) || value < 300 || value > 2_592_000);
    const automaticCountBudget =
      key === 'AUTO_INVESTIGATION_TENANT_LIMIT_24H' ||
      key === 'AUTO_INVESTIGATION_MONITOR_LIMIT_24H';
    const automaticCostBudget =
      key === 'AUTO_INVESTIGATION_TENANT_COST_LIMIT_USD_24H' ||
      key === 'AUTO_INVESTIGATION_MONITOR_COST_LIMIT_USD_24H';
    const invalidAutomaticBudget = value < 0 || (automaticCountBudget && !Number.isInteger(value));
    if (
      draft.trim() === '' ||
      !Number.isFinite(value) ||
      invalidArchiveDays ||
      invalidRecoveryChecks ||
      invalidEvidenceRowLimit ||
      invalidEvidenceBudget ||
      invalidTokenLifetime ||
      ((automaticCountBudget || automaticCostBudget) && invalidAutomaticBudget)
    ) {
      setInvalidKey(key);
      setSaveError(`Enter a valid number for ${key}.`);
      return;
    }
    setInvalidKey(null);
    setSaveError(null);
    setSavingKey(key);
    try {
      await savePlatformSetting(config.apiBaseUrl, getCredentials, key, value);
      dirtyKeys.current.delete(key);
      numeric.refetch();
    } catch (cause) {
      setSaveError(requestErrorMessage(cause, `Failed to save ${key}.`));
    } finally {
      setSavingKey(null);
    }
  };

  const saveLlm = async (credential: string): Promise<void> => {
    if (!llmDraft || savingLlm || savingKey !== null) return;
    if (
      !llmDraft.model.trim() ||
      !Number.isInteger(llmDraft.maxTurns) ||
      llmDraft.maxTurns < 1 ||
      llmDraft.maxTurns > 64 ||
      !validPricing(llmDraft.pricing) ||
      (llmDraft.provider === 'custom-anthropic' && !llmDraft.baseUrl)
    ) {
      setSaveError(
        'Complete the investigator model, turn limit, endpoint, and pricing. Custom pricing requires positive input and output rates.',
      );
      throw new Error('invalid LLM settings');
    }
    const retainsCredential =
      llm.settings?.credentialConfigured === true &&
      credentialIdentity(llm.settings.config) === credentialIdentity(llmDraft);
    if (llmDraft.authMode !== 'ambient' && !retainsCredential && !credential.trim()) {
      setSaveError('Enter a credential before activating this model configuration.');
      throw new Error('missing LLM credential');
    }
    setSaveError(null);
    setSavingLlm(true);
    try {
      await saveLlmSettings(config.apiBaseUrl, getCredentials, {
        config: { ...llmDraft, model: llmDraft.model.trim() },
        ...(credential.trim() ? { credential: credential.trim() } : {}),
      });
      llmDirty.current = false;
      llm.refetch();
    } catch (cause) {
      setSaveError(
        requestErrorMessage(
          cause,
          'Could not confirm the investigator model update. Refresh its status before retrying.',
        ),
      );
      throw cause;
    } finally {
      setSavingLlm(false);
    }
  };

  const loading = numeric.loading || llm.loading;
  const error = numeric.error || llm.error;
  const errorStatus = numeric.errorStatus ?? llm.errorStatus;
  const accessDenied = error && errorStatus === 403;
  const loadErrorMessage = error
    ? accessDenied
      ? 'Platform-operator access is required to view platform settings.'
      : 'Failed to load platform settings.'
    : null;
  const alertMessage = [loadErrorMessage, saveError].filter(Boolean).join(' ');
  const showLoadError = !loading && error && numeric.settings.length === 0 && !llm.settings;

  return (
    <section>
      {!embedded && (
        <PageHeader
          title="Settings"
          description="Configure investigator runtime, credentials, pricing, and platform automation."
        />
      )}
      {loading && numeric.settings.length === 0 && !llm.settings && (
        <StatePanel state="loading" title="Loading settings…" skeleton="settings" />
      )}
      <div
        id="platform-settings-alert"
        role="alert"
        aria-atomic="true"
        className={alertMessage && !showLoadError ? 'mb-3 text-sm text-critical' : undefined}
      >
        {showLoadError ? (
          <StatePanel
            state={accessDenied ? 'access' : 'error'}
            title={loadErrorMessage ?? 'Failed to load platform settings.'}
            description={
              accessDenied
                ? 'This account is not a platform operator.'
                : 'The settings registry could not be retrieved.'
            }
            onRetry={
              accessDenied
                ? undefined
                : () => {
                    numeric.refetch();
                    llm.refetch();
                  }
            }
            announce={false}
          />
        ) : (
          alertMessage
        )}
      </div>

      {error && (numeric.settings.length > 0 || llm.settings) && !accessDenied && (
        <button
          type="button"
          onClick={() => {
            numeric.refetch();
            llm.refetch();
          }}
          className="mb-3 rounded border border-critical-line bg-surface px-2.5 py-1 text-sm font-medium text-critical hover:bg-critical-soft"
        >
          Retry
        </button>
      )}

      {!loading && !error && numeric.settings.length === 0 && !llm.settings && (
        <StatePanel
          state="empty"
          title="No platform settings are available."
          description="The settings registry has no entries."
        />
      )}

      {llm.settings && llmDraft && (
        <div className="space-y-4">
          <LlmRuntimeEditor
            key={llm.settings.updatedAt ?? llm.settings.source}
            value={llmDraft}
            credentialConfigured={
              llm.settings.credentialConfigured &&
              credentialIdentity(llm.settings.config) === credentialIdentity(llmDraft)
            }
            source={llm.settings.source}
            disabled={savingLlm || savingKey !== null}
            onChange={(value) => {
              llmDirty.current = true;
              setLlmDraft(value);
              setSaveError(null);
            }}
            onSave={saveLlm}
          />
        </div>
      )}

      <SmtpSettingsCard />

      {[
        {
          id: 'authentication-settings',
          title: 'Authentication',
          description: 'Platform-wide credential lifetime policy.',
          settings: numeric.settings.filter(
            (setting) =>
              setting.key === 'MAX_TOKEN_LIFETIME_SEC' || setting.key.startsWith('SESSION_'),
          ),
        },
        {
          id: 'automation-settings',
          title: 'Queue and automation',
          description: 'Platform-wide scheduling and retention behavior.',
          settings: numeric.settings.filter(
            (setting) =>
              setting.key !== 'MAX_TOKEN_LIFETIME_SEC' && !setting.key.startsWith('SESSION_'),
          ),
        },
      ].map((group) =>
        group.settings.length > 0 ? (
          <section
            key={group.id}
            aria-labelledby={`${group.id}-title`}
            className="mt-4 rounded-lg border border-line bg-surface p-4"
          >
            <h2 id={`${group.id}-title`} className="font-medium text-ink">
              {group.title}
            </h2>
            <p className="mt-1 text-sm text-ink-muted">{group.description}</p>
            <ul className="mt-4 flex flex-col gap-3">
              {group.settings.map((setting) => {
                const inputId = `platform-setting-${setting.key}`;
                const descriptionId = `${inputId}-default`;
                const pending = savingKey !== null || savingLlm;
                const invalid = invalidKey === setting.key;
                const copy = NUMERIC_SETTING_COPY[setting.key] ?? {
                  label: setting.key,
                  description: '',
                  unit: '',
                };
                const archivePolicy = setting.key === 'INCIDENT_AUTO_ARCHIVE_DAYS';
                const bounds = NUMERIC_INPUT_BOUNDS[setting.key];
                // A blank archive draft is an in-progress edit, not a request to disable the
                // policy. The save guard rejects the blank value if the operator submits it.
                const archiveDraft = drafts[setting.key];
                const archiveMidEdit = archiveDraft !== undefined && archiveDraft.trim() === '';
                const archiveEnabled = archiveMidEdit || Number(archiveDraft ?? setting.value) > 0;
                return (
                  <li
                    key={setting.key}
                    className="rounded border border-line bg-surface-subtle p-3"
                  >
                    <div className="flex items-end gap-3">
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <label htmlFor={inputId} className="text-sm font-medium text-ink">
                          {copy.label}
                        </label>
                        {copy.description && (
                          <span className="text-xs text-ink-muted">{copy.description}</span>
                        )}
                        {archivePolicy && (
                          <label className="my-1 flex items-center gap-2 text-sm font-medium text-ink-secondary">
                            <input
                              type="checkbox"
                              checked={archiveEnabled}
                              disabled={pending}
                              onChange={(event) => {
                                dirtyKeys.current.add(setting.key);
                                const currentDays = Number(
                                  drafts[setting.key] ?? String(setting.value),
                                );
                                if (!event.target.checked && currentDays > 0) {
                                  previousArchiveDays.current[setting.key] = currentDays;
                                }
                                const enabledDays =
                                  previousArchiveDays.current[setting.key] ??
                                  (setting.value > 0
                                    ? setting.value
                                    : setting.defaultValue > 0
                                      ? setting.defaultValue
                                      : 7);
                                setDrafts((current) => ({
                                  ...current,
                                  [setting.key]: event.target.checked ? String(enabledDays) : '0',
                                }));
                                setInvalidKey(null);
                                setSaveError(null);
                              }}
                            />
                            Enabled
                          </label>
                        )}
                        <input
                          id={inputId}
                          type="number"
                          min={bounds?.min}
                          max={bounds?.max}
                          step={bounds?.step ?? 'any'}
                          aria-describedby={`${descriptionId}${invalid ? ' platform-settings-alert' : ''}`}
                          aria-invalid={invalid || undefined}
                          value={drafts[setting.key] ?? String(setting.value)}
                          disabled={pending || (archivePolicy && !archiveEnabled)}
                          onChange={(event) => {
                            dirtyKeys.current.add(setting.key);
                            setDrafts((current) => ({
                              ...current,
                              [setting.key]: event.target.value,
                            }));
                            setInvalidKey(null);
                            setSaveError(null);
                          }}
                          className="sre-field disabled:bg-surface-strong"
                        />
                        <span id={descriptionId} className="text-xs text-ink-muted">
                          {archivePolicy && !archiveEnabled
                            ? 'Automatic incident deletion is disabled.'
                            : `Default: ${setting.defaultValue}${copy.unit ? ` ${copy.unit}` : ''}`}
                        </span>
                      </div>
                      <button
                        type="button"
                        aria-label={`Save ${setting.key}`}
                        disabled={pending}
                        onClick={() => void saveNumeric(setting.key, setting.value)}
                        className="sre-action sre-action-primary"
                      >
                        Save
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null,
      )}
    </section>
  );
}
