import { useRef, useState } from 'react';
import { GitHubConnectWizard } from '../../src/components/GitHubConnectWizard';
import { prepareTestDelivery } from '../../src/test/connector-delivery';

export function GitHubRecoveryFixture() {
  const [open, setOpen] = useState(true);
  const checks = useRef(0);
  return (
    <main>
      {open && (
        <GitHubConnectWizard
          mode="edit"
          connectorId="00000000-0000-4000-8000-000000000007"
          apiBaseUrl="https://api.example.com"
          initialSettings={{
            appId: 'Iv1.saved',
            installationId: '42',
            appSlug: 'fixture-app',
            eventTransport: 'direct',
          }}
          initialWebhookPath="/webhooks/github/saved"
          eventFailureCategory="signature_mismatch"
          onPrepareDelivery={prepareTestDelivery}
          onStartManifest={async () => {
            throw Error('Unexpected manifest request');
          }}
          onCompleteManifest={async () => {
            throw Error('Unexpected manifest callback');
          }}
          onClose={() => setOpen(false)}
          onDiscoverInstallations={async (input) => {
            if (input.credential) throw Error('Webhook repair resubmitted private key');
            return [
              {
                id: 42,
                accountLogin: 'acme',
                accountType: 'Organization',
                repositorySelection: 'all',
                permissions: { contents: 'read' },
                writePermissions: [],
              },
            ];
          }}
          onSave={async (input) => {
            if (
              input.webhookSecret !== 'fixture-replacement-secret' ||
              input.credential ||
              input.id !== '00000000-0000-4000-8000-000000000007'
            )
              throw Error('Unexpected credential or identity mutation');
            return { connectorId: input.id, name: 'GitHub' };
          }}
          onRunTest={async () => {
            const success = checks.current++ > 0;
            return {
              status: success ? 'healthy' : 'unhealthy',
              reachable: true,
              authorized: success,
              warnings: success ? [] : ['Temporary verification failure'],
              enabled: success,
              checks: {
                canEnumerateRepositories: success,
                canReadContents: success,
                readOnlyApp: true,
                webhookSecretConfigured: true,
              },
            };
          }}
        />
      )}
    </main>
  );
}
