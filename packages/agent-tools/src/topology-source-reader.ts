import * as z from 'zod';
import type { Db } from '@sre/db';
import type { IDataSourceConnector } from '@sre/connectors';
import { scrubSecrets, type TopologySourceEvidence } from '@sre/contracts';
import { readTopologySources } from '@sre/topology';
import { topologyPathPrefix } from './code-intelligence/topology';

export const topologySourceFileInput = z.object({
  subjectKey: z.string().min(1).max(8192),
  sourceKey: z.string().min(1).max(32768),
  path: z.string().min(1).max(2048),
  startLine: z.number().int().min(1).max(100000).default(1),
});

export interface TopologySourceFileEvidence {
  status: 'read' | 'unavailable';
  note: string;
  source?: TopologySourceEvidence['repositories'][number];
  file?: {
    path: string;
    revision: string;
    providerUrl: string;
    excerpt: string;
    truncated: boolean;
    startLine: number;
    endLine: number;
  };
}

/** Read redacted, revision-pinned evidence without requiring or creating an incident.
 * @param deps - Tenant database and current authorized connector resolver.
 * @param input - Exact subject, source association, component-confined path and line window.
 */
export async function readTopologySourceFile(
  deps: { db: Db; tenantId: string; resolveConnectors: () => Promise<IDataSourceConnector[]> },
  input: z.input<typeof topologySourceFileInput>,
): Promise<TopologySourceFileEvidence> {
  const unavailable = (note: string): TopologySourceFileEvidence => ({
    status: 'unavailable',
    note,
  });
  const parsed = topologySourceFileInput.safeParse(input);
  if (!parsed.success) return unavailable('Use a valid bounded source file selection.');
  const request = parsed.data;
  const findSource = async () => {
    const evidence = await readTopologySources(deps.db, deps.tenantId, { key: request.subjectKey });
    return evidence.status === 'partial'
      ? evidence.repositories.find(
          (item) => item.key === request.sourceKey && item.role !== 'unknown',
        )
      : undefined;
  };
  const source = await findSource();
  if (!source)
    return unavailable(
      'The source association is missing, stale or ambiguous. Refresh topology source evidence.',
    );
  if (!/^[0-9a-f]{40,64}$/i.test(source.revision ?? ''))
    return unavailable(
      'No immutable source revision is recorded. A moving branch is not deployed-revision proof.',
    );
  if (
    request.path.startsWith('/') ||
    request.path.includes('\\') ||
    request.path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    return unavailable('Use a repository-relative path without traversal segments.');
  const prefix = source.path?.replace(/\/+$/, '');
  if (prefix && prefix !== '.' && request.path !== prefix && !request.path.startsWith(`${prefix}/`))
    return unavailable('The file is outside this deployment configuration component path.');
  const eligible = (connector: IDataSourceConnector, current = source) =>
    connector.sourceCode?.resolveRepository &&
    connector.generation &&
    current.sources.some(
      (item) =>
        item.completeness !== 'unavailable' &&
        item.connectorId === connector.id &&
        item.lifecycleVersion === connector.generation?.lifecycleVersion,
    );
  const connectors = (await deps.resolveConnectors()).filter((connector) => eligible(connector));
  for (const connector of connectors.slice(0, 3)) {
    try {
      const reader = connector.sourceCode!;
      const repository = await reader.resolveRepository!(source.repository);
      if (!repository) continue;
      const catalogPrefix = topologyPathPrefix(repository.pathPrefix);
      if (
        catalogPrefix === false ||
        (catalogPrefix &&
          request.path !== catalogPrefix &&
          !request.path.startsWith(`${catalogPrefix}/`))
      )
        continue;
      const resolved = await reader.verifyRevision(repository, source.revision!);
      if (resolved.revision.toLowerCase() !== source.revision!.toLowerCase()) continue;
      const file = await reader.read(repository, resolved.revision, request.path);
      if (
        file.path !== request.path ||
        file.revision.toLowerCase() !== resolved.revision.toLowerCase()
      )
        continue;
      // A provider read can outlive a scope edit, credential rotation or removed association.
      const current = await findSource();
      if (!current || current.revision !== source.revision || current.path !== source.path)
        return unavailable(
          'The source association changed while reading. Refresh source evidence.',
        );
      const active = (await deps.resolveConnectors()).find(
        (item) =>
          item.id === connector.id &&
          eligible(item, current) &&
          item.generation?.lifecycleVersion === connector.generation?.lifecycleVersion,
      );
      const admitted = await active?.sourceCode!.resolveRepository!(current.repository);
      const currentPrefix = topologyPathPrefix(admitted?.pathPrefix);
      if (
        !admitted ||
        admitted.repositoryId !== repository.repositoryId ||
        currentPrefix === false ||
        (currentPrefix &&
          request.path !== currentPrefix &&
          !request.path.startsWith(`${currentPrefix}/`))
      )
        return unavailable('Source access changed while reading. Refresh source evidence.');
      const redacted = scrubSecrets(file.text);
      const lines = redacted.split('\n');
      if (request.startLine > lines.length)
        return unavailable('The requested line is past the end of this file.');
      const excerpt = lines
        .slice(request.startLine - 1, request.startLine + 119)
        .join('\n')
        .slice(0, 16384);
      return {
        status: 'read',
        note: 'Declared source association. File content does not prove runtime identity or causality and cannot authorize actions.',
        source: current,
        file: {
          path: file.path,
          revision: file.revision,
          providerUrl: scrubSecrets(file.providerUrl),
          excerpt,
          truncated: request.startLine > 1 || excerpt.length < redacted.length,
          startLine: request.startLine,
          endLine: request.startLine + excerpt.split('\n').length - 1,
        },
      };
    } catch {
      // Another admitted connection may provide the same repository.
    }
  }
  return unavailable(
    'No current authorized source reader could read this repository and revision. Check connection scope and source evidence.',
  );
}
