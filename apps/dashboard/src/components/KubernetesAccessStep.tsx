import { SkeletonBlock } from './LoadingSkeleton';
import { SetupCommand } from './SetupCommand';
import { installCommand } from './KubernetesConnectSupport';

export function KubernetesAccessStep({
  accessMode,
  onAccessModeChange,
  keepStoredCredential,
  manifest,
  error,
  onRetry,
}: {
  accessMode: 'existing' | 'create';
  onAccessModeChange: (value: 'existing' | 'create') => void;
  keepStoredCredential: boolean;
  manifest: string;
  error: string;
  onRetry: () => void;
}) {
  return (
    <>
      <div>
        <h2 className="font-semibold text-ink">Choose cluster access</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Already installed read-only RBAC? Reuse it. You do not need a new service account for this
          connection.
        </p>
      </div>
      <fieldset className="grid gap-3">
        <legend className="sr-only">Cluster access method</legend>
        {(['existing', 'create'] as const).map((value) => (
          <label
            key={value}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-line-strong p-4 has-[:checked]:border-accent"
          >
            <input
              type="radio"
              name="kubernetes-access"
              className="mt-1"
              checked={accessMode === value}
              onChange={() => onAccessModeChange(value)}
            />
            <span className="min-w-0">
              <span className="block font-semibold">
                {value === 'existing' ? 'Use existing access' : 'Create dedicated access'}
              </span>
              <span className="mt-1 block text-sm text-ink-muted">
                {value === 'existing'
                  ? 'Keep your existing RBAC and provide its service account credential.'
                  : 'Generate installation commands for a dedicated read-only service account.'}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {accessMode === 'existing' ? (
        <div className="rounded-lg border border-line bg-surface-subtle p-4 text-sm text-ink-muted">
          <p>
            {keepStoredCredential
              ? 'Your stored credential will be reused unless you replace it in Credentials.'
              : 'In Credentials, paste an existing read-only service account token and the cluster CA if needed.'}
          </p>
          <p className="mt-2">
            The platform needs credentials before it can check access; an API URL or service account
            name alone is not enough. Verification reports the supplied credential’s access. No RBAC
            resources will be created or changed.
          </p>
        </div>
      ) : (
        <KubernetesAccessInstallation manifest={manifest} error={error} onRetry={onRetry} />
      )}
    </>
  );
}

function KubernetesAccessInstallation({
  manifest,
  error,
  onRetry,
}: {
  manifest: string;
  error: string;
  onRetry: () => void;
}) {
  return (
    <>
      <p className="text-sm text-ink-muted">
        Run this command in the target cluster only if you need dedicated access. It creates a
        service account with read-only workload, node, metric, event, and log access, but no Secret
        reads. Nothing is installed by the platform automatically.
      </p>
      {error ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-critical">
          <p role="alert">{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="rounded border border-critical-line px-2 py-1 text-xs font-medium"
          >
            Retry
          </button>
        </div>
      ) : manifest ? (
        <SetupCommand
          command={installCommand(manifest, 'apply')}
          copyLabel="Copy install command"
        />
      ) : (
        <div role="status" aria-live="polite" aria-busy="true" className="rounded-lg bg-code p-4">
          <span className="sr-only">Loading install command…</span>
          <div aria-hidden="true" className="space-y-2">
            <SkeletonBlock className="h-3 w-2/5 bg-code-muted" />
            <SkeletonBlock className="h-3 w-4/5 bg-code-muted" />
            <SkeletonBlock className="h-3 w-3/5 bg-code-muted" />
            <SkeletonBlock className="h-3 w-5/6 bg-code-muted" />
          </div>
        </div>
      )}
      <p className="text-xs text-ink-muted">
        Reapplying updates these exact named resources. A separate connection generates different
        names; choose existing access to reuse permissions you already installed.
      </p>
      {manifest && (
        <details className="rounded border border-line p-3">
          <summary className="cursor-pointer text-sm font-medium text-critical">
            Remove cluster access
          </summary>
          <div className="mt-3 space-y-2">
            <p className="text-xs text-ink-muted">
              Only remove resources installed with this command. Do not remove access shared by
              another connection or application.
            </p>
            <SetupCommand
              command={installCommand(manifest, 'delete')}
              copyLabel="Copy uninstall command"
            />
          </div>
        </details>
      )}
    </>
  );
}
