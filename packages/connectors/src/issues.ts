import * as z from 'zod';
import type { IssueChanges, IssueManagementSettings, RepositoryIssue } from '@sre/contracts';
import type { ConnectorConfig, RepositoryCatalogEntry } from './registry';

export interface IssueManager {
  repositoryUrl(repository: string): Promise<string>;
  validateChanges(changes: IssueChanges): void;
  prepareWrite(repository: string): Promise<PreparedIssueWrite>;
  repositories(query: string): Promise<RepositoryCatalogEntry[]>;
  resolve(repository: string, write?: boolean): Promise<RepositoryCatalogEntry>;
  list(repository: string, query?: string, state?: 'open' | 'closed'): Promise<RepositoryIssue[]>;
  get(repository: string, number: number): Promise<RepositoryIssue>;
  create(repository: string, changes: IssueChanges): Promise<RepositoryIssue>;
  update(repository: string, number: number, changes: IssueChanges): Promise<RepositoryIssue>;
}

export type PreparedIssueWrite = Pick<IssueManager, 'get' | 'create' | 'update'> & {
  repository: RepositoryCatalogEntry;
};

/** Capture admitted identity and credentials before the caller reserves its dispatch transaction.
 * @param config - Immutable connector generation.
 * @param reference - Exact requested repository.
 * @param factory - Provider adapter constructor for the captured configuration.
 */
export async function prepareIssueWrite(
  config: ConnectorConfig,
  reference: string,
  factory: (config: ConnectorConfig) => IssueManager,
): Promise<PreparedIssueWrite> {
  const repository = await issueRepositoryAccess(config).resolve(reference, true);
  let credential: string, issueCredential: string | undefined;
  try {
    credential = await config.getCredential();
    issueCredential = config.type === 'gitlab' ? await config.getIssueCredential?.() : undefined;
  } catch {
    throw new IssueRequestError(
      'Issue credentials are unavailable. Check the connection before trying again.',
    );
  }
  return {
    ...factory({
      ...config,
      getCredential: async () => credential,
      getIssueCredential: async () => issueCredential ?? '',
      repositories: {
        search: async () => [repository],
        resolve: async () => [repository],
        recentEvents: async () => [],
      },
    }),
    repository,
  };
}

export const issueManagementSchema = z
  .object({
    enabled: z.boolean(),
    repositories: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(255)
          .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/),
      )
      .max(100),
  })
  .strict()
  .refine(
    (value) => !value.enabled || value.repositories.length > 0,
    'Select at least one repository for issue management.',
  );

export const issueChangesSchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    body: z.string().max(20_000).optional(),
    labels: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
    assignees: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    state: z.enum(['open', 'closed']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Specify an issue change.');

/** Provider errors expose safe recovery instructions, never response bodies or credentials. */
export class IssueRequestError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}

/** Read the explicit write opt-in; malformed legacy settings never grant authority.
 * @param settings - Tenant-controlled connector settings.
 */
export function issueManagement(settings: Record<string, unknown>): IssueManagementSettings {
  const parsed = issueManagementSchema.safeParse(settings.issueManagement);
  return parsed.success ? parsed.data : { enabled: false, repositories: [] };
}

/** Resolve exact identity inside the admitted catalog and optional write allowlist.
 * @param config - Tenant-owned connector configuration.
 */
export function issueRepositoryAccess(config: ConnectorConfig) {
  const repositories = async (query: string) =>
    (await config.repositories?.search(query.trim(), 50)) ?? [];
  return {
    repositories,
    async resolve(reference: string, write = false) {
      const policy = issueManagement(config.settings);
      if (write && !policy.enabled)
        throw new IssueRequestError(
          'Enable issue management in this connection before publishing.',
        );
      const matches = (await repositories(reference)).filter(
        (row) =>
          row.fullName.toLowerCase() === reference.toLowerCase() || row.repositoryId === reference,
      );
      if (matches.length !== 1)
        throw new IssueRequestError(
          'Repository is outside this connection’s catalog or is ambiguous. Select its full path.',
        );
      const row = matches[0]!;
      if (
        !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(row.fullName) ||
        row.fullName.split('/').some((part) => part === '.' || part === '..') ||
        (config.type === 'github' && row.fullName.split('/').length !== 2)
      )
        throw new IssueRequestError(
          'Refresh the invalid repository catalog entry before managing issues.',
        );
      if (
        write &&
        (row.archived ||
          !policy.repositories.some((path) => path.toLowerCase() === row.fullName.toLowerCase()))
      )
        throw new IssueRequestError(
          'Issue writes are not enabled for this repository, or the repository is archived.',
        );
      return row;
    },
  };
}

/** Bound a provider response and classify uncertain writes without retrying them.
 * @param transport - Provider transport with a fixed, validated origin.
 * @param url - Adapter-selected endpoint.
 * @param headers - Adapter-selected authentication headers.
 * @param method - Fixed issue operation.
 * @param body - Validated issue fields only.
 */
export async function issueRequest(
  transport: typeof fetch,
  url: string,
  headers: RequestInit['headers'],
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  body?: unknown,
): Promise<unknown> {
  const write = method !== 'GET';
  let response: Response;
  try {
    response = await transport(url, {
      method,
      headers: { ...Object.fromEntries(new Headers(headers)), 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new IssueRequestError(
      write
        ? 'The provider outcome is unknown. Check the repository before attempting another change.'
        : 'The issue provider did not respond. Try reading again.',
      write,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const known = [400, 401, 403, 404, 409, 422, 429].includes(response.status);
    const message =
      response.status === 401 || response.status === 403
        ? 'Issue access was denied. Check the connection’s issue permission and credential.'
        : response.status === 404
          ? 'The issue or repository is unavailable. Check its identity and access.'
          : response.status === 429
            ? 'The provider rate limit was reached. This request was not retried.'
            : known
              ? 'The provider rejected the issue fields. Check labels, assignees and repository permissions.'
              : 'The provider outcome is unknown. Inspect the issue before attempting another change.';
    throw new IssueRequestError(message, write && !known);
  }
  try {
    if (!response.body) throw new Error('empty response');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0,
      text = '';
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.length;
      if (bytes > 1024 * 1024) {
        await reader.cancel();
        throw new Error('response limit');
      }
      text += decoder.decode(item.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch {
    throw new IssueRequestError(
      'The provider returned an unreadable issue response. Check the repository before repeating a change.',
      write,
    );
  }
}

export const issueNumber = z.number().int().positive().max(2_147_483_647);
