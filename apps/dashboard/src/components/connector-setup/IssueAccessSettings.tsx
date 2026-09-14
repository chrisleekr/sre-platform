import type { IssueManagementSettings } from '@sre/contracts';

export function IssueAccessSettings({
  provider,
  value,
  onChange,
  credential,
  onCredential,
}: {
  provider: 'github' | 'gitlab';
  value: IssueManagementSettings;
  onChange: (value: IssueManagementSettings) => void;
  credential?: string;
  onCredential?: (value: string) => void;
}) {
  return (
    <fieldset className="my-4 min-w-0 rounded-lg border border-line p-4">
      <legend className="px-1 font-semibold">Optional issue management</legend>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => onChange({ ...value, enabled: event.target.checked })}
        />
        Allow confirmed issue changes
      </label>
      <p className="mt-2 text-sm text-ink-muted">
        Investigation remains read-only. Members review a draft before creating, updating, closing
        or reopening an issue. Permanent deletion is not supported.
      </p>
      {value.enabled && (
        <div className="mt-3 space-y-3">
          <label className="block text-sm font-medium">
            Repositories allowed for issue changes
            <textarea
              className="mt-1 min-h-20 w-full rounded border border-line-strong bg-input p-2"
              value={value.repositories.join('\n')}
              onChange={(event) =>
                onChange({ ...value, repositories: event.target.value.split('\n') })
              }
              placeholder="team/service"
            />
          </label>
          <p className="text-xs text-ink-muted">
            One full repository path per line. Repositories must also be in this connection’s
            catalog. No wildcard or all-repository write grant.
          </p>
          {provider === 'github' ? (
            <p className="text-sm text-ink-muted">
              In GitHub App settings, open Permissions &amp; events → Repository permissions →
              Issues → Read and write. Save, then approve the updated permissions for the
              installation. Keep other permissions read-only. Runtime issue tokens are restricted to
              the selected repository.
            </p>
          ) : (
            <>
              <p className="text-sm text-ink-muted">
                In GitLab, create a dedicated project or group access token with api scope and a
                role allowed to edit the target issues. Limit its project access and expiry. Keep
                the discovery token read-only; paste the issue-write token below.
              </p>
              <label className="block text-sm font-medium">
                Issue-write access token
                <input
                  type="password"
                  autoComplete="new-password"
                  value={credential ?? ''}
                  onChange={(event) => onCredential?.(event.target.value)}
                  placeholder="Leave blank to keep the saved token"
                  className="mt-1 w-full rounded border border-line-strong bg-input p-2"
                />
              </label>
              <p className="text-xs text-ink-muted">
                Stored encrypted and never returned. Disabling issue management removes this token.
              </p>
            </>
          )}
        </div>
      )}
    </fieldset>
  );
}
