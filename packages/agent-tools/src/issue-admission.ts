import { and, eq, isNull } from 'drizzle-orm';
import { githubRepositories, gitlabProjects, type Tx } from '@sre/db';
import { IssueRequestError, type ConnectorType } from '@sre/connectors';

/** Lock the exact admitted catalog identity without acquiring another database connection.
 * @param tx - Existing tenant dispatch transaction.
 * @param provider - Source-control adapter type.
 * @param connectorId - Tenant-owned source identity.
 * @param repositoryId - Provider identity saved with the preview.
 * @param repository - Full path shown in the preview.
 */
export async function assertIssueAdmission(
  tx: Tx,
  provider: ConnectorType,
  connectorId: string,
  repositoryId: string,
  repository: string,
): Promise<void> {
  const catalog =
    provider === 'github'
      ? {
          table: githubRepositories,
          id: githubRepositories.repositoryId,
          path: githubRepositories.fullName,
        }
      : provider === 'gitlab'
        ? { table: gitlabProjects, id: gitlabProjects.projectId, path: gitlabProjects.fullPath }
        : null;
  if (!catalog) throw new IssueRequestError('This connection does not support issue management.');
  const rows = await tx
    .select({ id: catalog.table.id })
    .from(catalog.table)
    .where(
      and(
        eq(catalog.table.connectorId, connectorId),
        eq(catalog.id, repositoryId),
        eq(catalog.path, repository),
        eq(catalog.table.archived, false),
        isNull(catalog.table.removedAt),
      ),
    )
    .limit(1)
    .for('share');
  if (!rows.length)
    throw new IssueRequestError(
      'Repository admission changed since this preview. Refresh the connection catalog and prepare a new draft.',
    );
}
