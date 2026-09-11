import { describe, expect, test } from 'vitest';
import { connectorConfigs, connectorCredentialKey, withTenant } from '@sre/db';
import { createFixture } from './argocd-connector-lifecycle.acceptance.fixture';

const __fixture = createFixture();

describe('Argo CD HTTP transport', () => {
  test('requires explicit HTTP acknowledgement before saving an internal endpoint', async () => {
    const api = __fixture.connectorApp();
    const body = {
      settings: __fixture.projectSettings('http://argocd-server.argocd.svc.cluster.local', {
        accessRole: 'sre-platform-http',
        insecureSkipTLSVerify: true,
      }),
      credentials: __fixture.projectCredentials('internal-token'),
    };
    const headers = await __fixture.headers();
    const rejected = await api.request('/connectors/argocd', {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: 'HTTP transport requires explicit acknowledgement',
    });
    expect(
      await __fixture.secrets.get(__fixture.tenantId, connectorCredentialKey('argocd')),
    ).toBeNull();
    const saved = await api.request('/connectors/argocd', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ ...body, insecureHttpAcknowledged: true }),
    });
    expect(saved.status).toBe(200);
    const rows = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx.select().from(connectorConfigs),
    );
    expect(rows[0]?.settings).toMatchObject({ baseUrl: body.settings.baseUrl });
    expect(rows[0]?.settings).not.toHaveProperty('insecureSkipTLSVerify');
    expect(rows[0]?.enabled).toBe(false);
  });

  test('returns a safe actionable URL error instead of invalid settings', async () => {
    const response = await __fixture.connectorApp().request('/connectors/argocd', {
      method: 'PUT',
      headers: await __fixture.headers(),
      body: JSON.stringify({
        settings: __fixture.projectSettings('https://user:secret@argo.example'),
        credentials: __fixture.projectCredentials('token'),
      }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      error: expect.stringMatching(/without credentials, query parameters, or a fragment/),
    });
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});
