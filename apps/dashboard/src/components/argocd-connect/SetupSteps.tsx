import { SetupActions } from '../SetupDialogSlots';
import { DataSourceNameField } from '../DataSourceNameField';
import { ConnectorSetupGuide } from '../connector-setup/ConnectorSetupGuide';
import { SetupCommand } from '../SetupCommand';
import { newProject } from './support';
import type { ArgoCdWizardViewModel } from './view-model';

export function ArgoCdSetupSteps({ view }: { view: ArgoCdWizardViewModel }) {
  const {
    mode,
    initialSettings,
    step,
    setStep,
    dataSourceName,
    setDataSourceName,
    baseUrl,
    baseUrlError,
    usesHttp,
    httpAcknowledged,
    setHttpAcknowledged,
    setBaseUrl,
    trust,
    setTrust,
    caCert,
    setCaCert,
    insecureAcknowledged,
    setInsecureAcknowledged,
    applicationsInAnyNamespace,
    setApplicationsInAnyNamespace,
    projects,
    setProjects,
    labelSelector,
    setLabelSelector,
    error,
    continueFromServer,
    continueFromProjects,
  } = view;
  return (
    <>
      {step === 1 && (
        <div className="flex min-w-0 flex-col gap-4">
          <ConnectorSetupGuide provider="argocd" />
          <div>
            <h2 className="font-medium text-ink">Connect to one Argo CD server</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Project access is configured separately in the next steps. Enter the server address
              here. For HTTPS, choose how to verify its certificate.
            </p>
          </div>
          <DataSourceNameField
            value={dataSourceName}
            onChange={setDataSourceName}
            placeholder="Production Argo CD"
          />
          <label className="text-sm font-medium">
            Argo CD server URL
            <input
              type="url"
              aria-invalid={Boolean(baseUrlError)}
              aria-describedby={
                baseUrlError ? 'argocd-url-help argocd-url-error' : 'argocd-url-help'
              }
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              className="sre-field mt-1 min-w-0 w-full"
            />
          </label>
          <p id="argocd-url-help" className="text-xs text-ink-muted">
            Use HTTPS where available. HTTP is supported for internal services only, with explicit
            acknowledgement. Network policy must allow the platform to reach the server.
          </p>
          {baseUrlError && (
            <p id="argocd-url-error" role="alert" className="text-sm text-critical">
              {baseUrlError}
            </p>
          )}
          {usesHttp && (
            <label className="flex items-start gap-2 rounded border border-warning-line bg-warning-soft p-3 text-sm text-warning">
              <input
                type="checkbox"
                checked={httpAcknowledged}
                onChange={(event) => setHttpAcknowledged(event.target.checked)}
              />
              I understand that HTTP sends project tokens and API responses unencrypted over the
              internal network.
            </label>
          )}
          {!usesHttp && (
            <fieldset className="space-y-2">
              <legend className="font-medium">Server certificate trust</legend>
              {(['system', 'ca', 'insecure'] as const).map((option) => (
                <label key={option} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="argocd-tls"
                    checked={trust === option}
                    onChange={() => setTrust(option)}
                  />
                  {option === 'system'
                    ? 'Use system trust'
                    : option === 'ca'
                      ? 'Pin a CA certificate'
                      : 'Disable certificate verification'}
                </label>
              ))}
            </fieldset>
          )}
          {!usesHttp && trust === 'ca' && (
            <label htmlFor="argocd-ca-cert" className="text-sm font-medium">
              CA certificate (PEM)
              <textarea
                id="argocd-ca-cert"
                aria-label="CA certificate (PEM)"
                value={caCert}
                onChange={(event) => setCaCert(event.target.value)}
                rows={5}
                className="sre-field mt-1 min-w-0 w-full resize-y font-instrument text-xs"
              />
              <span className="mt-1 block text-xs font-normal text-ink-muted">
                {mode === 'edit' && initialSettings?.caConfigured
                  ? 'A CA is configured. Leave blank to keep it; the stored PEM is never prefilled.'
                  : 'Paste only the CA used to verify this Argo CD server.'}
              </span>
            </label>
          )}
          {!usesHttp && trust === 'insecure' && (
            <label className="flex items-start gap-2 rounded border border-critical-line bg-critical-soft p-3 text-sm text-critical">
              <input
                type="checkbox"
                checked={insecureAcknowledged}
                onChange={(event) => setInsecureAcknowledged(event.target.checked)}
              />
              I understand that disabling TLS verification permits server impersonation.
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button
              type="button"
              onClick={continueFromServer}
              className="sre-action sre-action-primary self-start"
            >
              Continue
            </button>
          </SetupActions>
        </div>
      )}

      {step === 2 && (
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <h2 className="font-medium text-ink">Choose Argo CD projects and applications</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Each project gets its own credential and verification result. List available projects
              from an authenticated Argo CD CLI, then add only the projects this tenant needs.
            </p>
          </div>
          <SetupCommand command="argocd proj list -o name" copyLabel="Copy project list command" />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={applicationsInAnyNamespace}
              onChange={(event) => {
                setApplicationsInAnyNamespace(event.target.checked);
                setProjects((current) =>
                  current.map((binding) => ({
                    ...binding,
                    credentialConfigured: false,
                    access: null,
                  })),
                );
              }}
            />
            Applications in any namespace is enabled
          </label>
          <p className="text-xs text-ink-muted">
            Leave this unchecked when Application objects live in Argo CD's own namespace. This
            refers to Argo CD's optional Applications-in-any-namespace feature, not the namespaces
            where your workloads are deployed. Select it only when that server feature is enabled.
          </p>
          <div className="space-y-4">
            {projects.map((binding, projectIndex) => (
              <fieldset key={projectIndex} className="space-y-3 rounded border border-line p-3">
                <legend className="px-1 text-sm font-semibold">Project {projectIndex + 1}</legend>
                <label className="block text-sm font-medium">
                  Project name
                  <input
                    aria-label={`Argo CD project ${projectIndex + 1}`}
                    value={binding.project}
                    onChange={(event) =>
                      setProjects((current) =>
                        current.map((project, index) =>
                          index === projectIndex
                            ? {
                                ...project,
                                project: event.target.value,
                                credentialConfigured: false,
                                access: null,
                              }
                            : project,
                        ),
                      )
                    }
                    className="sre-field mt-1 min-w-0 w-full"
                  />
                </label>
                {binding.applications.map((scope, scopeIndex) => (
                  <div key={scopeIndex} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    {applicationsInAnyNamespace && (
                      <label className="text-sm font-medium">
                        App namespace
                        <input
                          aria-label={`Argo CD app namespace ${projectIndex + 1}.${scopeIndex + 1}`}
                          value={scope.namespace}
                          onChange={(event) =>
                            setProjects((current) =>
                              current.map((project, index) =>
                                index === projectIndex
                                  ? {
                                      ...project,
                                      credentialConfigured: false,
                                      access: null,
                                      applications: project.applications.map(
                                        (application, appIndex) =>
                                          appIndex === scopeIndex
                                            ? { ...application, namespace: event.target.value }
                                            : application,
                                      ),
                                    }
                                  : project,
                              ),
                            )
                          }
                          className="sre-field mt-1 min-w-0 w-full"
                        />
                      </label>
                    )}
                    <label className="text-sm font-medium">
                      Application
                      <input
                        aria-label={`Argo CD application ${projectIndex + 1}.${scopeIndex + 1}`}
                        value={scope.name}
                        onChange={(event) =>
                          setProjects((current) =>
                            current.map((project, index) =>
                              index === projectIndex
                                ? {
                                    ...project,
                                    credentialConfigured: false,
                                    access: null,
                                    applications: project.applications.map(
                                      (application, appIndex) =>
                                        appIndex === scopeIndex
                                          ? { ...application, name: event.target.value }
                                          : application,
                                    ),
                                  }
                                : project,
                            ),
                          )
                        }
                        className="sre-field mt-1 min-w-0 w-full"
                      />
                    </label>
                    {binding.applications.length > 1 && (
                      <button
                        type="button"
                        aria-label={`Remove application ${projectIndex + 1}.${scopeIndex + 1}`}
                        onClick={() =>
                          setProjects((current) =>
                            current.map((project, index) =>
                              index === projectIndex
                                ? {
                                    ...project,
                                    credentialConfigured: false,
                                    access: null,
                                    applications: project.applications.filter(
                                      (_, appIndex) => appIndex !== scopeIndex,
                                    ),
                                  }
                                : project,
                            ),
                          )
                        }
                        className="self-end rounded border border-critical-line px-2 py-1.5 text-xs text-critical"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setProjects((current) =>
                        current.map((project, index) =>
                          index === projectIndex
                            ? {
                                ...project,
                                credentialConfigured: false,
                                access: null,
                                applications: [
                                  ...project.applications,
                                  { name: '*', namespace: '*' },
                                ],
                              }
                            : project,
                        ),
                      )
                    }
                    className="sre-action text-xs"
                  >
                    Add application scope
                  </button>
                  {projects.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setProjects((current) =>
                          current.filter((_, index) => index !== projectIndex),
                        )
                      }
                      className="rounded border border-critical-line px-2 py-1 text-xs text-critical"
                    >
                      Remove project
                    </button>
                  )}
                </div>
              </fieldset>
            ))}
          </div>
          <button
            type="button"
            disabled={projects.length >= 50}
            onClick={() => setProjects((current) => [...current, newProject('')])}
            className="sre-action self-start"
          >
            Add project
          </button>
          <label className="text-sm font-medium">
            Optional label selector
            <input
              value={labelSelector}
              onChange={(event) => setLabelSelector(event.target.value)}
              className="sre-field mt-1 min-w-0 w-full"
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-critical">
              {error}
            </p>
          )}
          <SetupActions>
            <button type="button" onClick={() => setStep(1)} className="rounded border px-3 py-1.5">
              Back
            </button>
            <button
              type="button"
              onClick={continueFromProjects}
              className="sre-action sre-action-primary"
            >
              Continue
            </button>
          </SetupActions>
        </div>
      )}
    </>
  );
}
