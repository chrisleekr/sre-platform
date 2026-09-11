import { savedHookScope, type HookScope } from './support';
import type { GitLabWizardViewModel } from './view-model';

const OPTIONS: { value: HookScope; title: string; access: string; coverage: string }[] = [
  {
    value: 'projects',
    title: 'Project hooks',
    access: 'Every GitLab tier · Project Maintainer or Owner',
    coverage:
      'Pushes and CI/CD events from projects with hooks installed. Existing manual installations remain manual.',
  },
  {
    value: 'group',
    title: 'Group hook',
    access: 'Premium or Ultimate · Group Owner',
    coverage:
      'One hook covers this group, its subgroups, and future projects. No instance administrator needed.',
  },
  {
    value: 'system',
    title: 'System hook + polling',
    access: 'Self-managed or Dedicated · Instance administrator installs the hook',
    coverage:
      'One instance hook supplies repository events. Read-only polling supplies pipeline, job, deployment, and release observations for this group.',
  },
];

export function GitLabDeliveryStrategy({ view }: { view: GitLabWizardViewModel }) {
  const initial = savedHookScope(view.initialSettings);
  return (
    <fieldset className="space-y-3 rounded-lg border border-line p-4">
      <legend className="px-1 font-semibold">How should changes reach this workspace?</legend>
      {OPTIONS.map((option) => (
        <label
          key={option.value}
          className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${view.hookScope === option.value ? 'border-line-strong bg-surface-subtle' : 'border-line'}`}
        >
          <input
            className="mt-1"
            type="radio"
            name="gitlab-hook-scope"
            value={option.value}
            checked={view.hookScope === option.value}
            onChange={() => view.setHookScope(option.value)}
          />
          <span className="min-w-0 space-y-1">
            <strong className="block">{option.title}</strong>
            <span className="block text-xs text-ink-secondary">{option.access}</span>
            <span className="block text-sm text-ink-muted">{option.coverage}</span>
          </span>
        </label>
      ))}
      {view.hookScope === 'projects' && (
        <label className="flex items-start gap-2 rounded border border-line p-3 text-sm">
          <input
            type="checkbox"
            checked={view.managedProjects}
            onChange={(event) => view.setManagedProjects(event.target.checked)}
          />
          <span>
            <strong>Automatically manage project hooks</strong>
            <span className="block text-ink-muted">
              After saving, a workspace administrator reviews the scope and supplies a separate
              management token. Future projects are included. Leave unchecked to keep manual
              installation.
            </span>
          </span>
        </label>
      )}
      <p className="text-xs text-ink-muted">
        Choose based on your GitLab permissions and plan. Enterprise edition alone does not confirm
        group-webhook entitlement.
      </p>
      {view.hookScope === 'system' && (
        <p className="rounded bg-warning-soft p-3 text-sm text-warning">
          GitLab sends instance-wide events to this receiver before SRE Platform discards unrelated
          projects and user data. Your GitLab administrator must approve that destination. Polling
          can miss intermediate transitions and is not a complete event history.
        </p>
      )}
      {view.mode === 'edit' && initial && initial !== view.hookScope && (
        <p className="rounded bg-warning-soft p-3 text-sm text-warning">
          Changing strategy does not remove existing GitLab hooks. Install and test the replacement,
          then remove only the old hooks for this connection. Polling cursors restart; stored
          evidence is retained.
        </p>
      )}
    </fieldset>
  );
}
