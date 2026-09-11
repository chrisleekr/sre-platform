import { SetupCommand } from '../SetupCommand';

export function ArgoCdExistingAccessHelp({
  project,
  role,
  showTokenCreation = true,
}: {
  project: string;
  role: string;
  showTokenCreation?: boolean;
}) {
  const projectName = project.trim();
  const roleName = role.trim();
  const validName = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
  const projectValid = projectName.length <= 253 && validName.test(projectName);
  const roleValid = roleName.length <= 63 && validName.test(roleName);

  return (
    <details
      open={!showTokenCreation}
      className="rounded-lg border border-line bg-surface-subtle p-4"
    >
      <summary className="cursor-pointer text-sm font-semibold text-ink">
        {showTokenCreation
          ? `How to find the existing role and token for ${projectName}`
          : `Confirm the project role exists for ${projectName}`}
      </summary>
      <div className="mt-4 min-w-0 space-y-4 text-sm">
        <p className="text-ink-muted">
          Run these commands on your computer, signed in with the Argo CD CLI to the server entered
          in step 1. You need permission to inspect project roles and create tokens. SRE Platform
          does not run these commands. This is an Argo CD project-role token, not a Kubernetes
          service account token.
        </p>
        {projectValid && (
          <section className="min-w-0 space-y-2">
            <h4 className="font-semibold">1. Find an existing read-only role</h4>
            <SetupCommand
              command={`argocd proj role list '${projectName}'`}
              copyLabel={`Copy ${projectName} role list command`}
            />
            <p className="text-xs text-ink-muted">
              {showTokenCreation && 'Enter its name in Existing project role name above. '}
              The role needs application and log read access for your selected scope, without sync,
              write or exec permissions.
            </p>
          </section>
        )}
        {projectValid && roleValid ? (
          <>
            <section className="min-w-0 space-y-2">
              <h4 className="font-semibold">2. Check its permissions</h4>
              <SetupCommand
                command={`argocd proj role get '${projectName}' '${roleName}'`}
                copyLabel={`Copy ${projectName} role details command`}
              />
              <p className="text-xs text-ink-muted">
                This shows policies and token metadata, not token values. If you already saved a
                valid token for this role, paste it below. Argo CD cannot retrieve a lost token.
              </p>
              <p className="text-xs text-warning">
                If the role is not found, confirm your CLI is connected to the server from step 1.
                The role must exist under spec.roles in this AppProject. Adding policy lines to
                global RBAC alone does not create a project role. A stored token is not proof that
                the role still exists. Do not create a token until the role lookup succeeds.
              </p>
            </section>
            {showTokenCreation && (
              <section className="min-w-0 space-y-2">
                <h4 className="font-semibold">3. No saved token? Create one for the same role</h4>
                <SetupCommand
                  command={`argocd proj role create-token '${projectName}' '${roleName}' --expires-in 8760h --token-only`}
                  copyLabel={`Copy ${projectName} existing-role token command`}
                />
                <p className="text-xs text-ink-muted">
                  This creates a new token, not a new role, and does not revoke existing tokens.
                  Paste the output into {projectName} project token below and keep it in your secret
                  store, not chat or source control. Do not delete the role to rotate a token.
                </p>
                <p className="text-xs text-warning">
                  This token expires in one year. Adjust the duration to your policy. SRE Platform
                  does not renew it automatically; replace it before expiry to keep access working.
                </p>
              </section>
            )}
          </>
        ) : (
          <p className="text-xs text-ink-muted">
            Enter a valid project and role name to see the role details and token commands.
          </p>
        )}
      </div>
    </details>
  );
}
