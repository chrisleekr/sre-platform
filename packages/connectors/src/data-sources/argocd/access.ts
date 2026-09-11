export interface ArgoCdProjectApplicationScope {
  name: string;
  namespace?: string;
}

export interface ArgoCdAccessRequest {
  project: string;
  role?: string;
  applicationsInAnyNamespace: boolean;
  applications: ArgoCdProjectApplicationScope[];
}

export interface ArgoCdAccessInstructions {
  project: string;
  role: string;
  identity: string;
  policies: string[];
  tokenCommand: string;
}

const SEGMENT_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$|^\*$/;
const NAME_CHARS = 253;
const NAMESPACE_CHARS = 63;
const LEGACY_ROLE = 'sre-platform';

function segment(name: string, value: string | undefined, maxChars: number): string {
  const normalized = value?.trim() ?? '';
  if (normalized.length > maxChars || !SEGMENT_RE.test(normalized))
    throw new Error(`invalid ArgoCD ${name}`);
  return normalized;
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Generates bounded least-privilege Argo CD project-role instructions.
 *
 * @param request - Project, role, and application scopes that require read access.
 */
export function generateArgoCdAccess(request: ArgoCdAccessRequest): ArgoCdAccessInstructions {
  const project = segment('project', request.project, NAME_CHARS);
  const role = segment('role', request.role ?? LEGACY_ROLE, NAMESPACE_CHARS);
  if (project === '*') throw new Error('a concrete ArgoCD project is required');
  if (role === '*') throw new Error('a concrete ArgoCD role is required');
  if (
    !Array.isArray(request.applications) ||
    request.applications.length === 0 ||
    request.applications.length > 50
  )
    throw new Error('one to 50 ArgoCD application scopes are required');

  const objects = request.applications.map((scope) => {
    const name = segment('application', scope.name, NAME_CHARS);
    if (!request.applicationsInAnyNamespace) {
      if (scope.namespace !== undefined) throw new Error('namespace requires any-namespace mode');
      return name;
    }
    return `${segment('application namespace', scope.namespace, NAMESPACE_CHARS)}/${name}`;
  });
  const identity = `proj:${project}:${role}`;
  const policies = objects.flatMap((object) => [
    `p, ${identity}, applications, get, ${project}/${object}, allow`,
    `p, ${identity}, logs, get, ${project}/${object}, allow`,
  ]);
  return {
    project,
    role,
    identity,
    policies,
    tokenCommand: `argocd proj role create-token ${shellArg(project)} ${shellArg(role)} --expires-in 8760h --token-only`,
  };
}

/**
 * Renders copyable install and uninstall commands from validated Argo CD access instructions.
 *
 * @param instructions - Validated project-role policies and identity.
 */
export function argoCdAccessCommands(instructions: ArgoCdAccessInstructions): {
  createRole: string;
  addPolicies: string;
  install: string;
  uninstall: string;
} {
  const project = shellArg(instructions.project);
  const role = shellArg(instructions.role);
  const identity = `proj:${instructions.project}:${instructions.role}`;
  if (
    !instructions.policies.every((row) => row.startsWith(`p, ${identity}, `)) ||
    instructions.policies.length === 0
  )
    throw new Error('invalid ArgoCD access instructions');
  const policyCommands = instructions.policies.map((row) => {
    const [, , resource, action, object, permission] = row.split(', ');
    if (!resource || !action || !object || !permission)
      throw new Error('invalid ArgoCD access instructions');
    const relativeObject = object.slice(`${instructions.project}/`.length);
    return [
      'argocd proj role add-policy',
      project,
      role,
      '--resource',
      shellArg(resource),
      '--action',
      shellArg(action),
      '--object',
      shellArg(relativeObject),
      '--permission',
      shellArg(permission),
    ].join(' ');
  });
  return {
    createRole: `argocd proj role create ${project} ${role} --description 'Read-only incident investigation'`,
    addPolicies: policyCommands.join('\n'),
    install: [
      `argocd proj role create ${project} ${role} --description 'Read-only incident investigation'`,
      ...policyCommands,
    ].join(' && \\\n'),
    uninstall: `argocd proj role delete ${project} ${role}`,
  };
}
