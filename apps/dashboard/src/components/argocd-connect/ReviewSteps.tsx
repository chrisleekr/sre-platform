import { SetupActions } from '../SetupDialogSlots';
import { SetupCommand } from '../SetupCommand';
import { ArgoCdExistingAccessHelp } from './ExistingAccessHelp';
import { host } from './support';
import type { ArgoCdWizardViewModel } from './view-model';

export function ArgoCdReviewSteps({ view }: { view: ArgoCdWizardViewModel }) {
  const {
    step,
    initialSettings,
    accessMode,
    accessRole,
    accessRoleLocked,
    chooseAccessMode,
    setExistingAccessRole,
    setStep,
    baseUrl,
    usesHttp,
    trust,
    applicationsInAnyNamespace,
    projects,
    setProjects,
    busyProject,
    busy,
    error,
    result,
    normalizedProjects,
    serverChanged,
    generateAccess,
    continueFromCredentials,
    saveAndVerify,
    onClose,
  } = view;
  return (
    <>
      {step === 3 && (
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <h2 className="font-semibold text-ink">Choose project access</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Reuse existing dedicated project-role tokens, or generate commands to install access.
              Neither option edits global Argo CD RBAC or your Helm values automatically.
            </p>
          </div>
          <fieldset className="grid gap-3 rounded-lg border border-line p-4">
            <legend className="px-1 text-sm font-medium">Access method</legend>
            {(['existing', 'create'] as const).map((value) => (
              <label key={value} className="flex min-h-10 items-center gap-3 text-sm">
                <input
                  type="radio"
                  name="argocd-access"
                  checked={accessMode === value}
                  disabled={busyProject !== null}
                  onChange={() => chooseAccessMode(value)}
                />
                {value === 'existing' ? 'Use existing project access' : 'Generate dedicated access'}
              </label>
            ))}
          </fieldset>
          {accessMode === 'create' && accessRoleLocked && (
            <p className="text-sm text-ink-muted">
              Generate instructions for the saved role <strong>{accessRole}</strong>. This does not
              create a different identity or change Argo CD automatically. Keep the existing role
              and token when correcting its permissions.
            </p>
          )}
          {accessMode === 'existing' && (
            <label className="text-sm font-medium">
              Existing project role name
              <input
                aria-label="Existing project role name"
                value={accessRole}
                readOnly={accessRoleLocked}
                disabled={busyProject !== null}
                onChange={(event) => setExistingAccessRole(event.target.value)}
                placeholder="incident-reader"
                maxLength={63}
                className="mt-1 w-full rounded border border-line-strong px-3 py-2"
              />
              <span className="mt-2 block text-xs font-normal text-ink-muted">
                Use the same dedicated role name in every selected project, with one token per
                project. It must not belong to another SRE Platform connection. Verification checks
                the token’s exact project-role identity and permissions. Stored role names cannot be
                changed here.
              </span>
            </label>
          )}
          {projects.map((binding, index) => (
            <section
              key={binding.project}
              className="min-w-0 space-y-3 rounded border border-line p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">{binding.project}</h3>
                {binding.credentialConfigured && !serverChanged && !binding.token.trim() && (
                  <span className="rounded bg-surface-subtle px-2 py-0.5 text-xs text-ink-muted">
                    Credential saved
                  </span>
                )}
              </div>
              {accessMode === 'existing' && (
                <ArgoCdExistingAccessHelp project={binding.project} role={accessRole} />
              )}
              {accessMode === 'create' && (
                <button
                  type="button"
                  disabled={busyProject !== null}
                  onClick={() => generateAccess(index)}
                  className="rounded border border-line-strong px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                >
                  {busyProject === index ? 'Generating…' : 'Generate access commands'}
                </button>
              )}
              {accessMode === 'create' && binding.access && (
                <div className="min-w-0 space-y-3 text-xs">
                  <ArgoCdExistingAccessHelp
                    project={binding.access.instructions.project}
                    role={binding.access.instructions.role}
                    showTokenCreation={false}
                  />
                  <p className="text-warning">
                    These commands are instructions, not live role checks. Run them against the
                    server from step 1 with authorized Argo CD CLI access. If GitOps manages this
                    AppProject, add the role and policies to its source manifest instead. Preserve
                    other project settings and roles.
                  </p>
                  <h4 className="font-semibold">Create the role only if it is missing</h4>
                  <p>
                    Skip this command if the role lookup succeeded. If lookup failed because of
                    authentication, connectivity or permissions, resolve that error first. Do not
                    delete an existing role to recreate it.
                  </p>
                  <SetupCommand
                    command={binding.access.commands.createRole}
                    copyLabel={`Copy ${binding.project} create role command`}
                  />
                  <h4 className="font-semibold">Grant the required read permissions</h4>
                  <SetupCommand
                    command={binding.access.commands.addPolicies}
                    copyLabel={`Copy ${binding.project} read policies command`}
                  />
                  <p>
                    These commands add read permissions; they do not remove old or excessive grants.
                    Repeat the role-details command above and review its policies before creating a
                    token. Verification checks the configured scope again.
                  </p>
                  <h4 className="font-semibold">Create a token only when needed</h4>
                  <p>
                    Keep a valid existing token when only updating permissions. If the role was
                    recreated or you need a replacement, generate a fresh one-year token below.
                    Replace it before expiry; SRE Platform does not renew pasted tokens
                    automatically.
                  </p>
                  <SetupCommand
                    command={binding.access.instructions.tokenCommand}
                    copyLabel={`Copy ${binding.project} token command`}
                  />
                  <details>
                    <summary className="cursor-pointer font-medium">Uninstall access later</summary>
                    <div className="mt-2">
                      <p className="mb-2 text-warning">
                        Remove this role only after disconnecting and confirming no other consumers
                        need it.
                      </p>
                      <SetupCommand
                        command={binding.access.commands.uninstall}
                        copyLabel={`Copy ${binding.project} uninstall command`}
                      />
                    </div>
                  </details>
                </div>
              )}
              <label className="block text-sm font-medium">
                {binding.project} project token
                <input
                  aria-label={`Argo CD token for ${binding.project}`}
                  type="password"
                  autoComplete="new-password"
                  value={binding.token}
                  onChange={(event) =>
                    setProjects((current) =>
                      current.map((project, projectIndex) =>
                        projectIndex === index
                          ? { ...project, token: event.target.value }
                          : project,
                      ),
                    )
                  }
                  className="mt-1 min-w-0 w-full rounded border border-line-strong px-2 py-1.5"
                />
                <span className="mt-1 block text-xs font-normal text-ink-muted">
                  Encrypted at rest and never shown again. Saving a credential does not confirm it
                  works.
                  {binding.credentialConfigured && !serverChanged
                    ? ' Leave blank to keep the saved credential, or paste a replacement.'
                    : serverChanged
                      ? ' The server changed, so a replacement token is required.'
                      : initialSettings?.projects?.some(
                            (saved) =>
                              saved.project === binding.project && saved.credentialConfigured,
                          )
                        ? ' The project scope changed, so a replacement token is required.'
                        : ' Paste a token for the selected project and role.'}
                </span>
              </label>
            </section>
          ))}
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button
              type="button"
              disabled={busyProject !== null}
              onClick={() => setStep(2)}
              className="rounded border px-3 py-1.5 disabled:opacity-50"
            >
              Back
            </button>
            <button
              type="button"
              disabled={busyProject !== null}
              onClick={continueFromCredentials}
              className="rounded bg-strong px-3 py-1.5 text-on-strong disabled:opacity-50"
            >
              Review
            </button>
          </SetupActions>
        </div>
      )}

      {step === 4 && (
        <div className="flex min-w-0 flex-col gap-4">
          <dl className="grid min-w-0 gap-3 rounded border border-line p-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-ink-muted">Server</dt>
              <dd className="break-words">{host(baseUrl)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Transport</dt>
              <dd>
                {usesHttp
                  ? 'HTTP, unencrypted internal network'
                  : trust === 'system'
                    ? 'System trust'
                    : trust === 'ca'
                      ? 'Pinned CA'
                      : 'Verification disabled'}
              </dd>
            </div>
            {normalizedProjects.map((binding, index) => (
              <div key={binding.project}>
                <dt className="text-xs text-ink-muted">Project {binding.project}</dt>
                <dd className="space-y-1 break-words">
                  {binding.applications.map((scope) => (
                    <span key={`${scope.namespace ?? ''}:${scope.name}`} className="block">
                      {applicationsInAnyNamespace ? `${scope.namespace}/${scope.name}` : scope.name}
                    </span>
                  ))}
                  <span className="block text-xs text-ink-muted">
                    {projects[index]!.token.trim()
                      ? 'New token will be encrypted'
                      : serverChanged || !projects[index]!.credentialConfigured
                        ? 'Replacement token required'
                        : 'Keep stored token'}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button type="button" onClick={() => setStep(3)} className="rounded border px-3 py-1.5">
              Back
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={saveAndVerify}
              className="rounded bg-strong px-3 py-1.5 text-on-strong disabled:opacity-50"
            >
              {busy ? 'Saving and verifying…' : 'Save and verify all projects'}
            </button>
          </SetupActions>
        </div>
      )}

      {step === 5 && result && (
        <div className="flex min-w-0 flex-col gap-4">
          <p
            className={`font-medium ${result.status === 'healthy' ? 'text-success' : 'text-critical'}`}
          >
            {result.status === 'healthy'
              ? 'Argo CD connector enabled for every project.'
              : 'Verification failed; the connector remains disabled.'}
          </p>
          <div className="space-y-3">
            {result.details?.projects?.map((project) => (
              <section key={project.project} className="rounded border border-line p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-semibold">{project.project}</h3>
                  <span className={project.status === 'healthy' ? 'text-success' : 'text-critical'}>
                    {project.status === 'healthy' ? 'Verified' : 'Failed'}
                  </span>
                </div>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>
                    Project-role identity: {project.checks?.identityMatches ? 'verified' : 'failed'}
                  </li>
                  <li>
                    Required application and log reads:{' '}
                    {project.checks?.requiredReadsVerified ? 'verified' : 'incomplete'}
                  </li>
                  <li>
                    Known over-grant samples:{' '}
                    {project.checks?.denySamplesPassed ? 'passed' : 'detected or not completed'}
                  </li>
                  <li>
                    Scoped applications:{' '}
                    {project.checks?.hasScopedApplications ? 'found' : 'none found or unreadable'}
                  </li>
                </ul>
                {project.warnings.map((warning) => (
                  <p key={warning} className="mt-2 text-warning">
                    {warning}
                  </p>
                ))}
              </section>
            ))}
          </div>
          {result.warnings.length > 0 &&
            !result.details?.projects?.length &&
            result.warnings.map((warning) => (
              <p key={warning} className="text-sm text-warning">
                {warning}
              </p>
            ))}
          <SetupActions>
            {result.status !== 'healthy' && (
              <button
                type="button"
                onClick={() => setStep(2)}
                className="rounded bg-strong px-3 py-1.5 text-on-strong"
              >
                Edit configuration
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className={
                result.status === 'healthy'
                  ? 'rounded bg-strong px-3 py-1.5 text-on-strong'
                  : 'rounded border border-line-strong px-3 py-1.5'
              }
            >
              {result.status === 'healthy' ? 'Finish' : 'Close'}
            </button>
          </SetupActions>
        </div>
      )}
    </>
  );
}
