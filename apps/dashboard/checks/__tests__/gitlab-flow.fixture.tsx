import { useMemo, useRef, useState } from 'react';
import { GitLabConnectWizard } from '../../src/components/GitLabConnectWizard';
import { GitLabDiscoveryRequestError } from '../../src/lib/connector-api/gitlab';
import { prepareGitLabTestDelivery } from '../../src/test/connector-delivery';
import type { GitLabManagementApi } from '../../src/lib/connector-api/gitlab-management';

export function GitLabFlowFixture() {
  const attempts = useRef(0);
  const [saved, setSaved] = useState(false);
  const [savedSettings, setSavedSettings] = useState<unknown>(null);
  const [open, setOpen] = useState(true);
  const managementApi = useMemo<GitLabManagementApi>(() => {
    let authorized = false;
    return {
      status: async () => ({
        authorized,
        approvedAt: null,
        catalogCheckedAt: null,
        failureCategory: null,
        counts: {
          missing: 0,
          total: 69,
          covered: authorized ? 69 : 0,
          failed: 0,
          pending: authorized ? 0 : 69,
        },
        projects: [],
      }),
      preview: async () => ({
        reviewDigest: 'fixture-review',
        scope: {
          baseUrl: 'https://gitlab.example.com',
          groupPath: 'platform',
          events: { push_events: true, pipeline_events: true },
        },
        receiver: 'Saved Smee channel (encrypted)',
        knownProjects: 69,
        projects: [
          { project: 'platform/service-1', recordedHookId: null, action: 'inspect_or_create' },
        ],
        effect: 'Create and maintain only this connection’s project hooks in the approved group.',
      }),
      authorize: async (_id, input) => {
        if (
          !input.approved ||
          input.reviewDigest !== 'fixture-review' ||
          input.managementToken !== 'fixture-management-token'
        )
          throw Error('Expected explicit fixture management approval');
        authorized = true;
      },
      revoke: async () => {
        authorized = false;
      },
    };
  }, []);
  return (
    <main>
      <p role="status">{saved ? 'Fixture saved' : 'Fixture unsaved'}</p>
      <output aria-label="Saved GitLab settings">{JSON.stringify(savedSettings)}</output>
      {open && (
        <GitLabConnectWizard
          mode="connect"
          managementApi={managementApi}
          apiBaseUrl="http://localhost:43000"
          onPrepareDelivery={prepareGitLabTestDelivery}
          onClose={() => setOpen(false)}
          onDiscover={async () => {
            if (attempts.current++ === 0)
              throw new GitLabDiscoveryRequestError(
                'GitLab temporarily unavailable. Retry discovery.',
              );
            return {
              group: {
                id: 7,
                name: 'Platform',
                fullPath: 'platform',
                webUrl: 'https://gitlab.example.com/groups/platform',
              },
              projects: Array.from({ length: 69 }, (_, index) => ({
                id: index + 1,
                name: `service-${index + 1}`,
                pathWithNamespace: `platform/service-${index + 1}`,
                webUrl: `https://gitlab.example.com/platform/service-${index + 1}`,
                archived: false,
              })),
              instance: { version: '19.2.4', enterprise: false },
            };
          }}
          onSave={async (body) => {
            setSaved(true);
            setSavedSettings(body.settings);
            return {
              connectorId: '00000000-0000-4000-8000-000000000099',
              name: 'GitLab',
              webhookPath: '/webhooks/gitlab/00000000-0000-4000-8000-000000000099',
              relayStatus: 'connected',
            };
          }}
          onRunTest={async () => ({
            status: 'healthy',
            reachable: true,
            authorized: true,
            warnings: [],
            enabled: true,
            checks: {
              canReadGroup: true,
              canEnumerateProjects: true,
              canReadCode: true,
              canReadPipelines: true,
              canReadDeployments: true,
              webhookSigningTokenConfigured: true,
            },
          })}
        />
      )}
    </main>
  );
}
