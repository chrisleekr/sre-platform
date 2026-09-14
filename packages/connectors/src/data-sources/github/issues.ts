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
import { mintInstallationToken, resolveCreds } from './auth';
import { GITHUB_API, ghHeaders } from './client';

const responseSchema = z.object({
  number: issueNumber,
  title: z.string(),
  body: z.string().nullable().optional(),
  state: z.enum(['open', 'closed']),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])).default([]),
  assignees: z.array(z.object({ login: z.string() })).default([]),
  updated_at: z.string(),
  pull_request: z.unknown().optional(),
});

/** Issue-only API port with fresh, single-repository installation tokens.
 * @param config - Tenant-scoped App configuration and admitted catalog.
 * @param transport - GitHub HTTP transport.
 */
export function makeGitHubIssues(config: ConnectorConfig, transport: typeof fetch): IssueManager {
  const access = issueRepositoryAccess(config);
  const endpoint = async (reference: string, write: boolean) => {
    const repository = await access.resolve(reference, write);
    if (
      !/^\d+$/.test(repository.repositoryId) ||
      !Number.isSafeInteger(Number(repository.repositoryId))
    )
      throw new IssueRequestError('Refresh the repository catalog before managing issues.');
    let token: string;
    try {
      const creds = resolveCreds(await config.getCredential(), config.settings);
      ({ token } = await mintInstallationToken(
        transport,
        GITHUB_API,
        creds,
        Math.floor(Date.now() / 1000),
        {
          repository_ids: [Number(repository.repositoryId)],
          permissions: { issues: write ? 'write' : 'read' },
        },
      ));
    } catch {
      throw new IssueRequestError(
        'GitHub issue access could not be authorized. Grant Issues permission to the App installation and check the connection.',
      );
    }
    return {
      repository,
      headers: ghHeaders(token),
      url: `${GITHUB_API}/repos/${repository.fullName.split('/').map(encodeURIComponent).join('/')}/issues`,
    };
  };
  const map = (raw: unknown, fullName: string, write = false): RepositoryIssue => {
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.pull_request || (parsed.data.body?.length ?? 0) > 20_000)
      throw new IssueRequestError(
        'This is not an editable issue response, or its body exceeds 20,000 characters. Open it in GitHub.',
        write,
      );
    const value = parsed.data;
    return {
      number: value.number,
      title: value.title,
      body: value.body ?? '',
      state: value.state,
      labels: value.labels.map((label) => (typeof label === 'string' ? label : label.name)),
      assignees: value.assignees.map((user) => user.login),
      updatedAt: value.updated_at,
      url: `https://github.com/${fullName}/issues/${value.number}`,
    };
  };
  const mutate = async (reference: string, number: number | undefined, raw: IssueChanges) => {
    const changes = issueChangesSchema.parse(raw);
    if (number === undefined && (!changes.title || changes.state !== undefined))
      throw new IssueRequestError('A new issue needs a title and starts open.');
    if (number !== undefined) issueNumber.parse(number);
    const target = await endpoint(reference, true);
    if (number !== undefined)
      map(
        await issueRequest(transport, `${target.url}/${number}`, target.headers, 'GET'),
        target.repository.fullName,
      );
    const result = await issueRequest(
      transport,
      target.url + (number === undefined ? '' : `/${number}`),
      target.headers,
      number === undefined ? 'POST' : 'PATCH',
      changes,
    );
    return map(result, target.repository.fullName, true);
  };
  return {
    ...access,
    repositoryUrl: async (reference) =>
      `https://github.com/${(await access.resolve(reference)).fullName}`,
    validateChanges: (changes) => {
      issueChangesSchema.parse(changes);
    },
    prepareWrite: (reference) =>
      prepareIssueWrite(config, reference, (captured) => makeGitHubIssues(captured, transport)),
    async list(reference, query = '', state = 'open') {
      const target = await endpoint(reference, false);
      const result = await issueRequest(
        transport,
        `${target.url}?per_page=50&state=${state}&sort=updated&direction=desc`,
        target.headers,
        'GET',
      );
      if (!Array.isArray(result))
        throw new IssueRequestError('GitHub returned an invalid issue list.');
      return result
        .filter((raw) => !raw?.pull_request)
        .map((raw) => map(raw, target.repository.fullName))
        .filter((row) => `${row.title}\n${row.body}`.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 50);
    },
    async get(reference, number) {
      issueNumber.parse(number);
      const target = await endpoint(reference, false);
      return map(
        await issueRequest(transport, `${target.url}/${number}`, target.headers, 'GET'),
        target.repository.fullName,
      );
    },
    create: (reference, changes) => mutate(reference, undefined, changes),
    update: (reference, number, changes) => mutate(reference, number, changes),
  };
}
