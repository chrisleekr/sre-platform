import type { ConnectorConfig } from '../../registry';
import type { ConnectorPollEvidence, NormalizedSnapshot } from '../../types';
import { obj, str, idStr } from '../../values';
import { apiBase, apiFetch, requestArrayPage, type FetchLike } from './client';
import { connectorToken } from './auth';
import { mapDeployment, matchesGitLabGroupScope } from './discovery';
import type { HostLookup } from '../../ssrf';

const STREAMS = ['pipeline', 'child_pipeline', 'job', 'deployment', 'release'] as const;
type Stream = (typeof STREAMS)[number];
const PATHS = {
  pipeline: 'pipelines',
  child_pipeline: 'pipelines',
  job: 'jobs',
  deployment: 'deployments',
  release: 'releases',
};
const ACTIVE = new Set(['created', 'pending', 'running', 'preparing', 'waiting_for_resource']);
const PAGE_SIZE = 20;
const BOOTSTRAP_MS = 24 * 60 * 60 * 1000;

function positive(value: unknown, fallback = 1): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function iso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function providerId(value: unknown): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const id = idStr(value);
  return /^[1-9]\d*$/.test(id) ? id : '';
}

function inGroup(path: unknown, group: string): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith(`${group}/`) &&
    !path.split('/').some((p) => !p || p === '.' || p === '..')
  );
}

function failure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/gitlab api (401|403)/.test(message)) return 'permission_denied';
  if (/gitlab api 429/.test(message)) return 'rate_limited';
  if (/gitlab api 404/.test(message)) return 'not_found';
  if (message === 'gitlab polling timestamp boundary exceeds page limit')
    return 'timestamp_boundary_limit';
  return 'provider_unavailable';
}

function snapshot(
  config: ConnectorConfig,
  kind: string,
  id: string,
  metadata: Record<string, unknown>,
  now: Date,
): NormalizedSnapshot {
  return {
    tenantId: config.tenantId,
    source: 'gitlab',
    entityId: id,
    metrics: {},
    metadata: { kind, ...metadata },
    observedAt: now,
  };
}

function observation(
  config: ConnectorConfig,
  raw: unknown,
  stream: Stream,
  projectId: string,
  repo: string,
  now: Date,
): NormalizedSnapshot[] {
  const value = obj(raw);
  const id = stream === 'release' ? str(value.tag_name) : providerId(value.id);
  if (!id) throw new Error('gitlab poll missing observation identity');
  const commit = obj(value.commit);
  const eventType = stream === 'child_pipeline' ? 'pipeline' : stream;
  const at =
    iso(value.updated_at) ??
    iso(value.finished_at) ??
    iso(value.released_at) ??
    iso(value.created_at);
  const details = {
    id,
    status: str(value.status),
    name: str(value.name),
    ref: str(value.ref),
    sha: str(value.sha) ?? str(commit.id),
    source: str(value.source),
    stage: str(value.stage),
    failureReason: str(value.failure_reason),
    url: str(value.web_url) ?? str(obj(value._links).self),
    tag: str(value.tag_name),
    at,
    revisionAt:
      stream === 'job' ? (str(value.finished_at) ?? str(value.started_at)) : str(value.updated_at),
  };
  const events = [
    snapshot(
      config,
      'gitlab-event',
      `${projectId}:${eventType}:${id}`,
      { projectId, repo, eventType, details },
      now,
    ),
  ];
  if (stream === 'deployment')
    events.push(
      snapshot(
        config,
        'gitlab-deployment',
        `${projectId}:${id}`,
        { ...mapDeployment(value, projectId), repo },
        now,
      ),
    );
  return events;
}

async function streamPage(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  base: string,
  token: string,
  projectId: string,
  repo: string,
  stream: Stream,
  saved: Record<string, unknown>,
  turn: number,
  now: Date,
) {
  const timed = stream === 'pipeline' || stream === 'child_pipeline' || stream === 'deployment';
  const page = timed ? 1 : positive(saved.page);
  const pageSize = timed && saved.boundaryPage === true ? 100 : PAGE_SIZE;
  // Jobs and releases lack updated-after filtering. Refresh the head between backlog pages.
  const head = !timed && page > 1 && turn % 2 === 0;
  const since = iso(saved.since) ?? new Date(now.getTime() - BOOTSTRAP_MS).toISOString();
  const until = iso(saved.until) ?? now.toISOString();
  const query = new URLSearchParams({ per_page: String(pageSize), page: String(head ? 1 : page) });
  if (timed) {
    query.set('order_by', 'updated_at');
    query.set('sort', 'asc');
    query.set('updated_after', since);
    query.set('updated_before', until);
  }
  if (stream === 'child_pipeline') query.set('source', 'parent_pipeline');
  const { response, values } = await requestArrayPage(
    fetchImpl,
    `${base}/projects/${encodeURIComponent(projectId)}/${PATHS[stream]}?${query}`,
    token,
  );
  const next = response.headers.get('x-next-page');
  const more = next === null ? values.length === pageSize : next !== '';
  let timedProgress: Record<string, unknown> | undefined;
  if (timed && more) {
    const timestamps = values.map((raw) => Date.parse(str(obj(raw).updated_at) ?? ''));
    if (
      !timestamps.length ||
      timestamps.some(
        (time, index) => !Number.isFinite(time) || (index > 0 && time < timestamps[index - 1]!),
      )
    )
      throw new Error('gitlab polling requires ordered update timestamps');
    // Replay the final millisecond, including sub-millisecond timestamps and equal-time records.
    const boundary = Math.max(Date.parse(since), timestamps.at(-1)! - 1);
    const stalled = boundary === Date.parse(since);
    if (stalled && pageSize === 100)
      throw new Error('gitlab polling timestamp boundary exceeds page limit');
    timedProgress = {
      page: 1,
      since: new Date(boundary).toISOString(),
      until,
      boundaryPage: stalled,
      pending: true,
    };
  }
  const snapshots = values.flatMap((raw) => observation(config, raw, stream, projectId, repo, now));
  const activeIds = { ...obj(saved.activeIds) };
  for (const raw of values) {
    const value = obj(raw),
      id = providerId(value.id);
    if (!id) continue;
    if (ACTIVE.has(str(value.status) ?? '')) activeIds[id] = true;
    else delete activeIds[id];
  }
  const activeEntries = Object.entries(activeIds);
  const activeOverflow = activeEntries.length > 100 || saved.activeOverflow === true;
  const state = head
    ? saved
    : more
      ? (timedProgress ?? { ...saved, page: page + 1, pending: true })
      : {
          page: 1,
          ...(timed ? { since: new Date(Date.parse(until) - 60_000).toISOString() } : {}),
          completedAt: now.toISOString(),
          pending: false,
        };
  return {
    snapshots,
    state: { ...state, activeIds: Object.fromEntries(activeEntries.slice(0, 100)), activeOverflow },
    active: activeEntries.length > 0 || activeOverflow,
  };
}

/**
 * Poll one bounded catalog page and up to four projects using only the investigation credential.
 * @param config - Saved tenant, group boundary, catalog access and captured connector cursor.
 * @param fetchImpl - HTTP transport for bounded read-only GitLab requests.
 * @param lookup - Resolver enforcing connector URL policy.
 */
export async function pollGitLabGroup(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  lookup: HostLookup,
): Promise<{ snapshots: NormalizedSnapshot[]; evidence: ConnectorPollEvidence }> {
  const expectedCursor = obj(config.settings.pollCursor);
  const now = new Date();
  const revision = positive(expectedCursor.revision, 0) + 1;
  const cursor: Record<string, unknown> = { ...expectedCursor, revision };
  const evidence: ConnectorPollEvidence = { cursor, expectedCursor, errorCount: 0 };
  if (Date.parse(str(expectedCursor.retryAt) ?? '') > now.getTime()) {
    return {
      snapshots: [],
      evidence: { ...evidence, errorCount: 1, failureCategory: 'rate_limited' },
    };
  }
  const base = await apiBase(config.settings, lookup);
  const token = await connectorToken(config);
  const group = str(config.settings.groupPath);
  const groupId = idStr(config.settings.groupId);
  if (!group || !groupId || !config.repositories?.pollCandidates)
    throw new Error('gitlab polling catalog unavailable');
  const snapshots: NormalizedSnapshot[] = [];
  const noteFailure = (category: string) => {
    evidence.errorCount = (evidence.errorCount ?? 0) + 1;
    if (category === 'rate_limited' || evidence.failureCategory !== 'rate_limited')
      evidence.failureCategory = category;
    if (category === 'rate_limited')
      cursor.retryAt = new Date(now.getTime() + 60_000).toISOString();
  };
  // Cached projects are not proof that the saved group still owns its namespace.
  try {
    if (!(await matchesGitLabGroupScope(config.settings, token, fetchImpl, lookup))) {
      noteFailure('group_scope_changed');
      return { snapshots, evidence: { ...evidence, cursor: expectedCursor } };
    }
  } catch (error) {
    noteFailure(failure(error));
    return {
      snapshots,
      evidence: {
        ...evidence,
        cursor: { ...expectedCursor, ...(cursor.retryAt ? { retryAt: cursor.retryAt } : {}) },
      },
    };
  }
  try {
    const catalogPage = positive(expectedCursor.catalogPage);
    const query = new URLSearchParams({
      include_subgroups: 'true',
      with_shared: 'false',
      per_page: String(PAGE_SIZE),
      page: String(catalogPage),
      order_by: 'id',
      sort: 'asc',
    });
    const { response, values } = await requestArrayPage(
      fetchImpl,
      `${base}/groups/${encodeURIComponent(groupId)}/projects?${query}`,
      token,
    );
    for (const raw of values) {
      const project = obj(raw);
      const id = providerId(project.id);
      if (
        !id ||
        !inGroup(project.path_with_namespace, group) ||
        !str(project.name) ||
        !str(project.web_url)
      )
        continue;
      snapshots.push(
        snapshot(
          config,
          'gitlab-project',
          id,
          {
            groupId,
            projectId: id,
            name: str(project.name),
            fullPath: project.path_with_namespace,
            webUrl: str(project.web_url),
            defaultBranch: str(project.default_branch),
            visibility: str(project.visibility),
            archived: project.archived === true,
          },
          now,
        ),
      );
    }
    const next = response.headers.get('x-next-page');
    cursor.catalogPage = (next === null ? values.length === PAGE_SIZE : next !== '')
      ? catalogPage + 1
      : 1;
    cursor.catalogObservedAt = now.toISOString();
  } catch (error) {
    noteFailure(failure(error));
    if (
      evidence.failureCategory === 'permission_denied' ||
      evidence.failureCategory === 'rate_limited'
    )
      return { snapshots, evidence };
  }

  const candidates = (await config.repositories.pollCandidates()).slice(0, 4);
  await Promise.all(
    candidates.map(async (candidate) => {
      const state = obj(candidate.cursor);
      const nextState: Record<string, unknown> = { ...state, turn: positive(state.turn, 0) + 1 };
      const errors: string[] = [];
      let repo = candidate.fullName;
      let removed = false;
      try {
        if (!inGroup(repo, group)) throw new Error('gitlab polling project outside group');
        const project = obj(
          (
            await apiFetch(
              fetchImpl,
              `${base}/projects/${encodeURIComponent(candidate.repositoryId)}`,
              token,
            )
          ).json,
        );
        if (providerId(project.id) !== candidate.repositoryId)
          throw new Error('gitlab polling project identity mismatch');
        if (!inGroup(project.path_with_namespace, group)) removed = true;
        else {
          repo = project.path_with_namespace;
          await Promise.all(
            STREAMS.map(async (stream) => {
              try {
                const result = await streamPage(
                  config,
                  fetchImpl,
                  base,
                  token,
                  candidate.repositoryId,
                  repo,
                  stream,
                  obj(state[stream]),
                  Number(nextState.turn),
                  now,
                );
                snapshots.push(...result.snapshots);
                nextState[stream] = result.state;
                nextState[`${stream}Active`] = result.active;
              } catch (error) {
                errors.push(failure(error));
              }
            }),
          );
        }
      } catch (error) {
        errors.push(failure(error));
      }
      for (const category of errors) noteFailure(category);
      snapshots.push(
        snapshot(
          config,
          'gitlab-poll-state',
          candidate.repositoryId,
          {
            projectId: candidate.repositoryId,
            cursor: nextState,
            removed,
            active: STREAMS.some((stream) => nextState[`${stream}Active`] === true),
            failureCategory: errors[0] ?? null,
          },
          now,
        ),
      );
    }),
  );
  if (evidence.failureCategory !== 'rate_limited') delete cursor.retryAt;
  return { snapshots, evidence };
}
