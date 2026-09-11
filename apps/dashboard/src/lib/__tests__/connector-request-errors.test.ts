// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import {
  saveKubernetesConnector,
  savePrometheusConnector,
  saveStatusCakeConnector,
  saveObservabilityConnector,
  saveArgoCdConnector,
  saveGitHubConnector,
  saveGitLabConnector,
} from '../useConnectors';
import { saveSlackSurface, toggleChannel } from '../useSurfaces';
import { savePlatformSetting } from '../usePlatformSettings';
import { RequestError } from '../request-error';

const url = 'https://api.example.test';
const credentials = async () => ({ kind: 'cookie' as const });
const requests = {
  kubernetes: () =>
    saveKubernetesConnector(url, credentials, {
      name: 'Production',
      settings: { apiUrl: url, namespace: '' },
      enabled: false,
    }),
  prometheus: () =>
    savePrometheusConnector(url, credentials, {
      name: 'Production',
      settings: { baseUrl: url, authType: 'none' },
    }),
  statuscake: () => saveStatusCakeConnector(url, credentials, { name: 'Production' }),
  datadog: () =>
    saveObservabilityConnector(url, credentials, 'datadog', { name: 'Production', settings: {} }),
  grafana: () =>
    saveObservabilityConnector(url, credentials, 'grafana', { name: 'Production', settings: {} }),
  argocd: () =>
    saveArgoCdConnector(url, credentials, {
      name: 'Production',
      settings: { baseUrl: url, projects: [], applicationsInAnyNamespace: false },
    }),
  github: () =>
    saveGitHubConnector(url, credentials, {
      name: 'Production',
      settings: { appId: '1', installationId: '2' },
    }),
  gitlab: () =>
    saveGitLabConnector(url, credentials, {
      name: 'Production',
      settings: { baseUrl: url, groupId: 1, groupPath: 'platform' },
    }),
  slack: () => saveSlackSurface(url, credentials, {}),
  inbound: () => toggleChannel(url, credentials, 'C123', true),
  settings: () => savePlatformSetting(url, credentials, 'max_turns', 1),
};
afterEach(() => vi.unstubAllGlobals());

test('setting failures refer to the setting rather than a connector', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'database exception' }, { status: 503 })),
  );
  await expect(requests.settings()).rejects.toThrow(
    'The setting update could not be confirmed. Refresh its value before retrying.',
  );
});

test.each(Object.entries(requests))(
  '%s preserves actionable API rejections',
  async (_name, request) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'A new credential is required.' }, { status: 409 })),
    );
    await expect(request()).rejects.toBeInstanceOf(RequestError);
    await expect(request()).rejects.toThrow('A new credential is required.');
  },
);

test('Kubernetes save exposes duplicate-name recovery without attempting verification', async () => {
  const fetch = vi.fn(async () =>
    Response.json({ error: 'a data source with this name already exists' }, { status: 409 }),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(requests.kubernetes()).rejects.toMatchObject({ code: 'duplicate_data_source_name' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
