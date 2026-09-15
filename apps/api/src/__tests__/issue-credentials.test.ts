import { expect, test } from 'vitest';
import { connectorIssueCredentialKey } from '@sre/db';
import { createFixture } from './connectors.fixture';

const f = createFixture();
test('GitLab issue opt-in stores a separate encrypted credential, preserves blank edits and removes it on disable', async () => {
  const api = f.makeConnApp();
  const headers = f.bearer(await f.sign(f.orgA));
  const settings = {
    baseUrl: 'https://gitlab.example.com',
    groupId: 7,
    groupPath: 'platform',
    groupName: 'Platform',
    eventTransport: 'direct',
    issueManagement: { enabled: true, repositories: ['platform/service'] },
  };
  const save = (body: unknown) =>
    api.request('/connectors/gitlab', { method: 'PUT', headers, body: JSON.stringify(body) });
  const missing = await save({
    settings,
    credential: 'read-only-credential',
    webhookSecret: 'dedicated-test-webhook-secret',
  });
  expect(missing.status).toBe(400);
  const created = await save({
    settings,
    credential: 'read-only-credential',
    webhookSecret: 'dedicated-test-webhook-secret',
    issueCredential: 'separate-issue-credential',
  });
  expect(created.status, await created.clone().text()).toBe(200);
  const source = await f.activeConnector('gitlab');
  const key = connectorIssueCredentialKey(source.id);
  expect(await f.secrets.get(f.tenantA, key)).toBe('separate-issue-credential');
  expect(await f.activeCredential('gitlab')).not.toContain('separate-issue-credential');
  const list = await api.request('/connectors', { headers });
  expect(await list.text()).not.toContain('separate-issue-credential');
  const edited = await save({ settings });
  expect(edited.status, await edited.clone().text()).toBe(200);
  expect(await f.secrets.get(f.tenantA, key)).toBe('separate-issue-credential');
  const moved = await save({ settings: { ...settings, groupId: 8 } });
  expect(moved.status).toBe(400);
  const disabled = await save({
    settings: { ...settings, issueManagement: { enabled: false, repositories: [] } },
  });
  expect(disabled.status).toBe(200);
  expect(await f.secrets.get(f.tenantA, key)).toBeNull();
});
