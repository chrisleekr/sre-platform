import type { TopologyRef } from '@sre/contracts';

/** Normalize an explicit repository location without retaining credentials or fetching that URL.
 * @param value - Repository HTTPS or SSH location reported by the provider.
 */
export function repositoryTopologyRef(value: string): TopologyRef | null {
  try {
    const scp = value.match(/^[^\s@]+@([a-zA-Z0-9.-]+):([^\s?#]+)$/);
    const url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : value);
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || url.password) return null;
    const path = url.pathname
      .replace(/^\//, '')
      .replace(/\/$/, '')
      .replace(/\.git$/, '');
    if (!path || !url.hostname) return null;
    // HTTP and SSH are transports for a repository, not separate repository identities.
    return {
      authority: `repository:${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}`,
      kind: 'repository',
      id: path,
    };
  } catch {
    return null;
  }
}
