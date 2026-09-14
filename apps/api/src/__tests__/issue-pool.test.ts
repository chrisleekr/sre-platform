import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import {
  connectorConfigs,
  connectorCredentialKey,
  connectorIssueCredentialKey,
  makeDb,
  makeSecretStore,
  syncGitLabProjects,
} from '@sre/db';
import { ConnectorRegistry, gitlabConnectorDefinition, makeGitLabConnector } from '@sre/connectors';
import { makeDbConnectorProvider, prepareIssueAction, decideIssueAction } from '@sre/agent-tools';
import { issueFixture } from './issue-management.fixture';

const f = issueFixture();
test('more concurrent confirmations than pool slots finish with the production catalog and encrypted credential resolver', async () => {
  f.configure('gitlab');
  const handle = makeDb(process.env.APP_DATABASE_URL!);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await f.admin.db
      .update(connectorConfigs)
      .set({
        type: 'gitlab',
        settings: {
          baseUrl: 'https://gitlab.example.com',
          groupId: 7,
          groupPath: 'team',
          issueManagement: { enabled: true, repositories: ['team/service'] },
        },
      })
      .where(eq(connectorConfigs.id, f.connectorId));
    const secrets = makeSecretStore(handle.db, Buffer.alloc(32, 9).toString('base64'));
    await secrets.put(f.tenantId, connectorCredentialKey(f.connectorId), 'read-token');
    await secrets.put(f.tenantId, connectorIssueCredentialKey(f.connectorId), 'write-token');
    await syncGitLabProjects(handle.db, f.tenantId, f.connectorId, '7', [
      {
        groupId: '7',
        projectId: '71',
        name: 'service',
        fullPath: 'team/service',
        defaultBranch: 'main',
        visibility: 'private',
        archived: false,
        webUrl: 'https://gitlab.example.com/team/service',
      },
    ]);
    const registry = new ConnectorRegistry([
      {
        ...gitlabConnectorDefinition,
        create: (config) => makeGitLabConnector(config, f.transport, async () => ['93.184.216.34']),
      },
    ]);
    const provider = makeDbConnectorProvider({ db: handle.db, secrets, registry });
    const deps = {
      db: handle.db,
      hub: f.hub,
      resolveConnectors: (tenant: string) => provider(tenant)(),
    };
    const drafts = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const incident = await f.incident();
        const draft = await prepareIssueAction(deps, f.tenantId, incident, f.actor, randomUUID(), {
          connectorId: f.connectorId,
          repository: 'team/service',
          changes: { title: 'Pool regression' },
        });
        return { incident, draft };
      }),
    );
    const results = await Promise.race([
      Promise.all(
        drafts.map(({ incident, draft }) =>
          decideIssueAction(deps, f.tenantId, incident, f.actor, draft.id, 'confirm'),
        ),
      ),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error('Confirmation stalled while acquiring a database connection')),
          5000,
        );
      }),
    ]);
    expect(results.every((result) => result.status === 'succeeded')).toBe(true);
    expect(f.writes).toHaveLength(10);
  } finally {
    clearTimeout(deadline);
    await handle.sql.end({ timeout: 0 });
  }
}, 15_000);
