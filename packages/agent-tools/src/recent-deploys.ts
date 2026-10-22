import { recentDeploys, type Db, type DeployRow } from '@sre/db';
import * as z from 'zod';
import type { ToolDefinition } from './types';

const fetchRecentDeploysInput = z.object({
  // Optional: defaults to the incident's primary service. The engine may pass a different service to
  // check the deploys of an upstream/downstream it starts to suspect.
  service: z.string().min(1).optional(),
  // How many recent deploys to return (newest first). Repo default applies when omitted.
  limit: z.number().int().positive().max(100).optional(),
});

export type FetchRecentDeploysInput = z.infer<typeof fetchRecentDeploysInput>;

/**
 * Builds the tenant-scoped recent deployment lookup tool.
 *
 * @param deps - Database dependency used to read durable deployment history.
 */
export function makeFetchRecentDeploysTool(deps: {
  db: Db;
}): ToolDefinition<FetchRecentDeploysInput, DeployRow[]> {
  return {
    name: 'fetch_recent_deploys',
    description:
      'Return a service recent deploys (newest first): provider event, repo, environment, actor, ref, full revision, status, URL, and provider timestamps. Defaults to the incident service, or every service when the incident only has a Slack channel placeholder; pass a service to re-scope, or a limit to bound the count.',
    inputSchema: fetchRecentDeploysInput,
    async handler(ctx, input) {
      const service = input.service ?? ctx.service;
      const data = await recentDeploys(deps.db, ctx.tenantId, {
        // Deploy rows carry provider app names, never a Slack channel placeholder, so read tenant-wide.
        service: service.startsWith('slack:') ? undefined : service,
        limit: input.limit,
      });
      return { available: true, data };
    },
  };
}
