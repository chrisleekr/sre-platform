import * as z from 'zod';
import type { IssueChanges, RepositoryIssue } from '@sre/contracts';
import type { ConnectorConfig } from '../../registry';
import {
  issueChangesSchema,
  issueNumber,
  issueRepositoryAccess,
  issueRequest,
  IssueRequestError,
  prepareIssueWrite,
  type IssueManager,
} from '../../issues';
import type { HostLookup } from '../../ssrf';
import { apiBase } from './client';
import { gitLabAccessToken } from './auth';

const responseSchema = z.object({
  iid: issueNumber,
  title: z.string(),
  description: z.string().nullable().optional(),
  state: z.enum(['opened', 'closed']),
  labels: z.array(z.string()).default([]),
  assignees: z.array(z.object({ id: issueNumber })).default([]),
  updated_at: z.string(),
});

/** GitLab issue port; mutations use a separate credential and never arbitrary API paths.
 * @param config - Tenant-owned instance and repository policy.
 * @param transport - GitLab HTTP transport.
 * @param lookup - DNS resolver for the existing SSRF guard.
 */
export function makeGitLabIssues(
  config: ConnectorConfig,
  transport: typeof fetch,
  lookup: HostLookup,
): IssueManager {
  const access = issueRepositoryAccess(config);
  const validateChanges = (changes: IssueChanges) => {
    issueChangesSchema.parse(changes);
    if (changes.body !== undefined && /^[ \t]*\//m.test(changes.body.replace(/\r/g, '')))
      throw new IssueRequestError(
        'GitLab quick actions are not supported in issue descriptions. Remove or escape slash-leading lines and prepare a new draft.',
      );
    if (changes.labels?.some((label) => label.includes(',')))
      throw new IssueRequestError('GitLab issue labels cannot contain commas.');
    if (
      changes.assignees?.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))
    )
      throw new IssueRequestError('GitLab assignees must be numeric user IDs.');
  };
  const endpoint = async (reference: string, write: boolean) => {
    const repository = await access.resolve(reference, write);
    const base = await apiBase(config.settings, lookup);
    let token: string | null | undefined;
    try {
      token = write
        ? await config.getIssueCredential?.()
        : gitLabAccessToken(await config.getCredential());
    } catch {
      throw new IssueRequestError(
        'GitLab issue credentials are unavailable. Check the connection before trying again.',
      );
    }
    if (!token)
      throw new IssueRequestError(
        'Configure a separate GitLab issue-write token with api scope and project access.',
      );
    return {
      repository,
      headers: { 'PRIVATE-TOKEN': token },
      url: `${base}/projects/${encodeURIComponent(repository.repositoryId)}/issues`,
      web: base.replace(/\/api\/v4$/, ''),
    };
  };
  const map = (raw: unknown, web: string, fullName: string, write = false): RepositoryIssue => {
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success || (parsed.data.description?.length ?? 0) > 20_000)
      throw new IssueRequestError(
        'GitLab returned an invalid issue or a body over 20,000 characters. Open it in GitLab.',
        write,
      );
    const value = parsed.data;
    return {
      number: value.iid,
      title: value.title,
      body: value.description ?? '',
      state: value.state === 'opened' ? 'open' : 'closed',
      labels: value.labels,
      assignees: value.assignees.map((user) => String(user.id)),
      updatedAt: value.updated_at,
      url: `${web}/${fullName}/-/issues/${value.iid}`,
    };
  };
  const mutate = async (reference: string, number: number | undefined, raw: IssueChanges) => {
    const changes = issueChangesSchema.parse(raw);
    validateChanges(changes);
    if (number === undefined && (!changes.title || changes.state !== undefined))
      throw new IssueRequestError('A new issue needs a title and starts open.');
    if (number !== undefined) issueNumber.parse(number);
    const target = await endpoint(reference, true);
    const project = z
      .object({ id: issueNumber, path_with_namespace: z.string(), archived: z.boolean() })
      .safeParse(
        await issueRequest(transport, target.url.replace(/\/issues$/, ''), target.headers, 'GET'),
      );
    if (
      !project.success ||
      String(project.data.id) !== target.repository.repositoryId ||
      project.data.path_with_namespace !== target.repository.fullName ||
      project.data.archived
    )
      throw new IssueRequestError(
        'The GitLab project changed or is archived. Refresh the connection catalog and prepare a new preview.',
      );
    const body = {
      ...(changes.title !== undefined ? { title: changes.title } : {}),
      ...(changes.body !== undefined ? { description: changes.body } : {}),
      ...(changes.labels ? { labels: changes.labels.join(',') } : {}),
      ...(changes.assignees ? { assignee_ids: changes.assignees.map(Number) } : {}),
      ...(changes.state ? { state_event: changes.state === 'open' ? 'reopen' : 'close' } : {}),
    };
    const result = await issueRequest(
      transport,
      target.url + (number === undefined ? '' : `/${number}`),
      target.headers,
      number === undefined ? 'POST' : 'PUT',
      body,
    );
    return map(result, target.web, target.repository.fullName, true);
  };
  return {
    ...access,
    repositoryUrl: async (reference) =>
      `${(await apiBase(config.settings, lookup)).replace(/\/api\/v4$/, '')}/${(await access.resolve(reference)).fullName}`,
    validateChanges,
    prepareWrite: (reference) =>
      prepareIssueWrite(config, reference, (captured) =>
        makeGitLabIssues(captured, transport, lookup),
      ),
    async list(reference, query = '', state = 'open') {
      const target = await endpoint(reference, false);
      const result = await issueRequest(
        transport,
        `${target.url}?per_page=50&scope=all&state=${state === 'open' ? 'opened' : 'closed'}&search=${encodeURIComponent(query)}&order_by=updated_at&sort=desc`,
        target.headers,
        'GET',
      );
      if (!Array.isArray(result))
        throw new IssueRequestError('GitLab returned an invalid issue list.');
      return result.slice(0, 50).flatMap((raw) => {
        try {
          return [map(raw, target.web, target.repository.fullName)];
        } catch (error) {
          if (error instanceof IssueRequestError) return [];
          throw error;
        }
      });
    },
    async get(reference, number) {
      issueNumber.parse(number);
      const target = await endpoint(reference, false);
      return map(
        await issueRequest(transport, `${target.url}/${number}`, target.headers, 'GET'),
        target.web,
        target.repository.fullName,
      );
    },
    create: (reference, changes) => mutate(reference, undefined, changes),
    update: (reference, number, changes) => mutate(reference, number, changes),
  };
}
