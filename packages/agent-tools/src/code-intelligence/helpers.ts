import type { IDataSourceConnector, RuntimeArtifact, SourceRepository } from '@sre/connectors';
import {
  deploymentBoundaryAsOf,
  filterIncidentEvidenceIds,
  getIncidentSummary,
  incidentSignalOnset,
  type DeploymentBoundary,
} from '@sre/db';
import { createHash } from 'node:crypto';
import { readIncidentTopologySources } from '@sre/topology';
import {
  EXCERPT_CONTEXT_LINES,
  MAX_EXCERPT_CHARS,
  MAX_EXCERPT_LINES,
  MAX_PATH_CANDIDATES,
  MAX_RUNTIME_ARTIFACTS,
  MAX_SEARCH_QUERIES,
  type CodeContextReader,
  type CodeLocationEvidence,
  type InvestigateCodeDeps,
  type InvestigateCodeInput,
  type RepositoryTarget,
  type ResolvedRevision,
  type SearchAnchor,
  type StackAnchor,
} from './contracts';

export class ProviderCallBudgetExceeded extends Error {}

export const isBudgetFailure = (error: unknown): error is ProviderCallBudgetExceeded =>
  error instanceof ProviderCallBudgetExceeded;

export function codeContextReader(deps: InvestigateCodeDeps): CodeContextReader {
  if (deps.context) return deps.context;
  return {
    incident: (tenantId, incidentId) => getIncidentSummary(deps.db, tenantId, incidentId),
    sources: (tenantId, incidentId, legacyService) =>
      readIncidentTopologySources(deps.db, tenantId, incidentId, legacyService),
    onset: (tenantId, incidentId) => incidentSignalOnset(deps.db, tenantId, incidentId),
    evidenceIds: (tenantId, incidentId, proposed) =>
      filterIncidentEvidenceIds(deps.db, tenantId, incidentId, proposed),
    deploymentBoundary: (tenantId, service, repository, at) =>
      deploymentBoundaryAsOf(deps.db, tenantId, {
        service,
        source: repository.provider,
        connectorId: repository.dataSourceId,
        repository: repository.fullName,
        repositoryId: repository.repositoryId,
        at,
      }),
  };
}

export const normalizedText = (value: string | undefined): string => value?.trim() ?? '';

export function stackAnchors(stackTrace: string): StackAnchor[] {
  const anchors: StackAnchor[] = [];
  for (const lineText of stackTrace.split('\n').slice(0, 200)) {
    const python = /File\s+["']([^"']+)["'],\s+line\s+(\d+)/.exec(lineText);
    const generic =
      /((?:[A-Za-z]:)?[A-Za-z0-9_@+./\\-]+\.[A-Za-z][A-Za-z0-9]*):(\d+)(?::\d+)?/.exec(lineText);
    const match = python ?? generic;
    if (!match) continue;
    const path = match[1]?.replaceAll('\\', '/').replace(/^file:\/\//, '') ?? '';
    if (!path || path.split('/').includes('..') || /^https?:\/\//i.test(path)) continue;
    const functionName = /\bat\s+([^\s(]+)/.exec(lineText)?.[1] ?? null;
    anchors.push({ path, line: Number(match[2]) || null, functionName });
  }
  return [
    ...new Map(
      anchors.map((anchor) => [`${anchor.path}\0${anchor.line ?? ''}`, anchor] as const),
    ).values(),
  ].slice(0, 10);
}

function webSourceIdentity(value: string): { origin: string; path: string } | null {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || !['http:', 'https:'].includes(parsed.protocol))
      return null;
    return {
      origin: parsed.origin.toLowerCase(),
      path: parsed.pathname
        .replace(/^\/+|\/+$/g, '')
        .replace(/\.git$/i, '')
        .toLowerCase(),
    };
  } catch {
    return null;
  }
}

function repositoryNameFromSource(sourceUrl: string, repository: SourceRepository): boolean {
  const source = webSourceIdentity(sourceUrl);
  const catalog = webSourceIdentity(repository.webUrl);
  return Boolean(
    source && catalog && source.origin === catalog.origin && source.path === catalog.path,
  );
}

export function repositoryRank(target: RepositoryTarget, artifacts: RuntimeArtifact[]): number {
  const artifactMatch = artifacts.some(
    (artifact) =>
      artifact.sourceUrl && repositoryNameFromSource(artifact.sourceUrl, target.repository),
  );
  const resolution =
    target.repository.resolution === 'confirmed_mapping'
      ? 0
      : target.repository.resolution === 'discovered_mapping'
        ? 1
        : 2;
  const role = target.repository.role === 'application_source' ? 0 : 100;
  // Catalog mappings are authoritative. Runtime annotations are deployment declarations and only
  // break ties between repositories with the same role and mapping strength.
  return role + resolution * 10 + (artifactMatch ? 0 : 1);
}

export function pathCandidates(runtimePath: string, pathPrefix: string | null): string[] {
  const clean = runtimePath
    .replace(/^file:\/\//, '')
    .replace(/[?#].*$/, '')
    .replace(/^\/+/, '')
    .replaceAll('\\', '/');
  if (!clean || clean.split('/').includes('..')) return [];
  const parts = clean.split('/').filter(Boolean);
  const suffixes = new Set<string>();
  for (const marker of ['src', 'app', 'apps', 'packages', 'lib', 'server']) {
    const index = parts.lastIndexOf(marker);
    if (index >= 0) suffixes.add(parts.slice(index).join('/'));
  }
  if (parts.length > 1) suffixes.add(parts.slice(-2).join('/'));
  suffixes.add(clean);
  const candidates = [...suffixes];
  const prefixed: string[] = [];
  if (pathPrefix) {
    for (const candidate of candidates) {
      if (candidate !== pathPrefix && !candidate.startsWith(`${pathPrefix}/`))
        prefixed.push(`${pathPrefix}/${candidate}`);
    }
  }
  return [...new Set([...prefixed, ...candidates])].slice(0, MAX_PATH_CANDIDATES);
}

export function queryAnchors(input: InvestigateCodeInput, anchors: StackAnchor[]): SearchAnchor[] {
  const values = new Map<string, SearchAnchor>();
  const addPhrase = (source: string | undefined, kind: SearchAnchor['matchedBy']) => {
    const phrase = normalizedText(source).replace(/\s+/g, ' ').trim();
    if (phrase.length < 4) return;
    const bounded = phrase.slice(0, 128);
    if (!values.has(bounded)) values.set(bounded, { query: bounded, matchedBy: kind });
  };
  const addToken = (source: string | undefined, kind: SearchAnchor['matchedBy']) => {
    const token = normalizedText(source)
      .match(/[A-Za-z_][A-Za-z0-9_.-]{3,127}/g)
      ?.filter(
        (candidate) =>
          !['error', 'exception', 'failed', 'failure', 'undefined', 'warning'].includes(
            candidate.toLowerCase(),
          ),
      )
      .sort((a, b) => b.length - a.length)[0];
    if (token && !values.has(token)) values.set(token, { query: token, matchedBy: kind });
  };
  for (const anchor of anchors)
    if (anchor.functionName && anchor.functionName.length >= 4)
      values.set(anchor.functionName.slice(0, 128), {
        query: anchor.functionName.slice(0, 128),
        matchedBy: 'stack_symbol',
      });
  addPhrase(input.errorText, 'error_text');
  addToken(input.errorText, 'error_text');
  addPhrase(input.focus, 'focus');
  addToken(input.focus, 'focus');
  return [...values.values()].slice(0, MAX_SEARCH_QUERIES);
}

function sourceLine(text: string, query: string): number | null {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return null;
  return text.slice(0, index).split('\n').length;
}

function excerpt(
  text: string,
  line: number | null,
): {
  startLine: number;
  endLine: number;
  excerpt: string;
} {
  const lines = text.split('\n');
  const center = line && line > 0 ? Math.min(line, lines.length) : 1;
  const start = Math.max(1, center - EXCERPT_CONTEXT_LINES);
  const end = Math.min(lines.length, start + MAX_EXCERPT_LINES - 1, center + EXCERPT_CONTEXT_LINES);
  let rendered = lines
    .slice(start - 1, end)
    .map((value, index) => `${start + index}: ${value}`)
    .join('\n');
  if (rendered.length > MAX_EXCERPT_CHARS)
    rendered = `${rendered.slice(0, MAX_EXCERPT_CHARS - 1)}…`;
  return { startLine: start, endLine: end, excerpt: rendered };
}

export async function observeArtifacts(
  connectors: IDataSourceConnector[],
  service: string,
): Promise<{
  artifacts: RuntimeArtifact[];
  failed: boolean;
  countTruncated: boolean;
  readerIncomplete: boolean;
}> {
  const readers = connectors.flatMap((connector) =>
    connector.runtimeArtifacts ? [connector.runtimeArtifacts] : [],
  );
  const settled = await Promise.allSettled(readers.map((reader) => reader.observe(service)));
  const artifacts = settled.flatMap((result) =>
    result.status === 'fulfilled' ? result.value.artifacts : [],
  );
  return {
    artifacts: artifacts.slice(0, MAX_RUNTIME_ARTIFACTS),
    failed: settled.some((result) => result.status === 'rejected'),
    countTruncated: artifacts.length > MAX_RUNTIME_ARTIFACTS,
    readerIncomplete: settled.some(
      (result) => result.status === 'fulfilled' && result.value.incomplete,
    ),
  };
}

export async function resolveRepositories(
  connectors: IDataSourceConnector[],
  service: string,
): Promise<{ repositories: RepositoryTarget[]; failed: boolean }> {
  const readers = connectors.flatMap((connector) =>
    connector.sourceCode ? [{ connector, reader: connector.sourceCode }] : [],
  );
  const settled = await Promise.allSettled(
    readers.map(async ({ reader }) =>
      (await reader.resolve(service)).map((repository) => ({ reader, repository })),
    ),
  );
  const unique = new Map<string, RepositoryTarget>();
  for (const target of settled.flatMap((result) =>
    result.status === 'fulfilled' ? result.value : [],
  ))
    unique.set(
      `${target.repository.dataSourceId}\0${target.repository.provider}\0${target.repository.fullName}`,
      target,
    );
  return {
    repositories: [...unique.values()],
    failed: settled.some((result) => result.status === 'rejected'),
  };
}

export async function resolveRevision(
  target: RepositoryTarget,
  artifacts: RuntimeArtifact[],
  boundary: DeploymentBoundary,
  consume: () => void,
): Promise<ResolvedRevision | null> {
  if (target.topology) {
    const revision = target.topology.revision;
    if (!revision || !/^[0-9a-f]{40,64}$/i.test(revision)) return null;
    consume();
    const verified = await target.reader.verifyRevision(target.repository, revision);
    if (verified.revision.toLowerCase() !== revision.toLowerCase()) return null;
    return {
      evidence: {
        repository: target.repository,
        revision: verified.revision,
        role: target.repository.role,
        basis: 'topology_declaration',
        strength: 'declared',
        providerUrl: verified.providerUrl,
        deployedAt: null,
        uncertainties: [
          'current topology source declaration, not verified image provenance or proof of the revision at incident onset',
        ],
        topologyEvidenceRefs: target.topology.evidenceKeys,
        topologyObservedAt: [
          ...new Set(target.topology.sources.map((source) => source.observedAt)),
        ],
      },
      previousRevision: null,
    };
  }
  const artifact = artifacts.find(
    (candidate) =>
      candidate.sourceUrl &&
      candidate.revision &&
      repositoryNameFromSource(candidate.sourceUrl, target.repository),
  );
  const laterApplicationDeploy = boundary.firstAfter !== null;
  if (artifact?.revision && !laterApplicationDeploy) {
    consume();
    const verified = await target.reader.verifyRevision(target.repository, artifact.revision);
    return {
      evidence: {
        repository: target.repository,
        revision: verified.revision,
        role: target.repository.role,
        basis: 'runtime_annotation',
        strength: artifact.provenance ?? 'declared',
        providerUrl: verified.providerUrl,
        deployedAt: null,
        uncertainties: [
          'source and revision came from current workload metadata; revision existence was verified but its binding to the image digest was not',
        ],
      },
      previousRevision: null,
    };
  }

  const deployed = boundary.current;
  if (deployed) {
    consume();
    const verified = await target.reader.verifyRevision(target.repository, deployed.sha);
    return {
      evidence: {
        repository: target.repository,
        revision: verified.revision,
        role: target.repository.role,
        basis: 'deployment_event',
        strength: 'corroborated',
        providerUrl: verified.providerUrl,
        deployedAt: deployed.deployedAt.toISOString(),
        uncertainties: ['runtime artifact digest was not bound to this deployment revision'],
      },
      previousRevision: boundary.previous?.sha ?? null,
    };
  }

  if (!target.repository.defaultBranch) return null;
  consume();
  const head = await target.reader.verifyRevision(
    target.repository,
    target.repository.defaultBranch,
  );
  return {
    evidence: {
      repository: target.repository,
      revision: head.revision,
      role: target.repository.role,
      basis: 'default_head',
      strength: 'candidate',
      providerUrl: head.providerUrl,
      deployedAt: null,
      uncertainties: ['no exact deployed application revision was available'],
    },
    previousRevision: null,
  };
}

function matchedBy(
  input: InvestigateCodeInput,
  anchor: StackAnchor | null,
  text: string,
  discovery: SearchAnchor | null,
): CodeLocationEvidence['matchedBy'] {
  const matches: CodeLocationEvidence['matchedBy'] = [];
  if (anchor) matches.push('stack_path');
  if (anchor?.functionName && text.includes(anchor.functionName)) matches.push('stack_symbol');
  if (input.errorText && sourceLine(text, input.errorText) !== null) matches.push('error_text');
  if (input.focus && sourceLine(text, input.focus) !== null) matches.push('focus');
  if (discovery && sourceLine(text, discovery.query) !== null) matches.push(discovery.matchedBy);
  return [...new Set(matches)];
}

export async function codeLocation(
  target: RepositoryTarget,
  revision: ResolvedRevision,
  path: string,
  requestedLine: number | null,
  input: InvestigateCodeInput,
  anchor: StackAnchor | null,
  discovery: SearchAnchor | null,
  sourceEvidenceIds: string[],
  consume: () => void,
  remaining: () => number,
): Promise<CodeLocationEvidence> {
  if (target.topology) {
    const prefix = target.repository.pathPrefix;
    if (
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      (prefix && path !== prefix && !path.startsWith(`${prefix}/`))
    )
      throw new Error('Source path is outside the topology component');
  }
  consume();
  const file = await target.reader.read(target.repository, revision.evidence.revision!, path);
  if (
    file.path !== path ||
    file.revision.toLowerCase() !== revision.evidence.revision!.toLowerCase()
  ) {
    revision.evidence.uncertainties.push(
      'Source response did not match the requested path and revision; its content was discarded.',
    );
    throw new Error('Source response does not match the requested path and revision');
  }
  const discoveredLine = discovery ? sourceLine(file.text, discovery.query) : null;
  if (discovery && discoveredLine === null)
    throw new Error('discovered source anchor is absent at the incident revision');
  const queryLine = discovery
    ? discoveredLine
    : (requestedLine ??
      [input.errorText, input.focus, anchor?.functionName]
        .filter((value): value is string => Boolean(value))
        .map((value) => sourceLine(file.text, value))
        .find((value) => value !== null) ??
      null);
  const rendered = excerpt(file.text, queryLine);
  let changedFromPreviousRevision: boolean | null = null;
  if (revision.previousRevision && remaining() >= 2) {
    try {
      consume();
      const previous = await target.reader.verifyRevision(
        target.repository,
        revision.previousRevision,
      );
      consume();
      const comparison = await target.reader.compare(
        target.repository,
        previous.revision,
        revision.evidence.revision!,
      );
      changedFromPreviousRevision = comparison.files.some(
        (candidate) => candidate.path === file.path,
      );
      if (!changedFromPreviousRevision && comparison.filesIncomplete) {
        changedFromPreviousRevision = null;
        revision.evidence.uncertainties.push(
          `deployment comparison was incomplete for ${target.repository.fullName}`,
        );
      }
    } catch (error) {
      if (isBudgetFailure(error)) throw error;
      changedFromPreviousRevision = null;
    }
  }
  return {
    repository: target.repository,
    revision: revision.evidence.revision!,
    revisionBasis: revision.evidence.basis,
    strength: revision.evidence.strength,
    path: file.path,
    startLine: rendered.startLine,
    endLine: rendered.endLine,
    excerpt: rendered.excerpt,
    excerptSha256: createHash('sha256').update(rendered.excerpt).digest('hex'),
    providerUrl:
      target.repository.provider === 'gitlab'
        ? `${file.providerUrl}#L${rendered.startLine}-${rendered.endLine}`
        : `${file.providerUrl}#L${rendered.startLine}-L${rendered.endLine}`,
    matchedBy: matchedBy(input, anchor, file.text, discovery),
    changedFromPreviousRevision,
    causality: changedFromPreviousRevision ? 'possible' : 'unknown',
    sourceEvidenceIds,
  };
}
