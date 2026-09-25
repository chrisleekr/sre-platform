import { NativeWebhookInstructions } from './connector-setup/NativeWebhookInstructions';
import type { ConnectorTestResult } from '../lib/connectors';
import { SetupActions } from './SetupDialogSlots';

/** Shows the verified connection result after saving the connector. */
export function ObservabilityVerificationResult({
  result,
  name,
  onClose,
  type,
  webhookPath,
}: {
  result: ConnectorTestResult;
  name: string;
  onClose(): void;
  type: 'datadog' | 'grafana';
  /** The server-issued path. It is keyed by the webhook key, which need not equal the connector id. */
  webhookPath?: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h2
        className={`font-medium ${result.status === 'healthy' ? 'text-success' : 'text-critical'}`}
      >
        {result.status === 'healthy'
          ? `${name} enabled.`
          : 'Verification failed; this connection remains disabled.'}
      </h2>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li>Endpoint reachable: {result.reachable ? 'yes' : 'no'}</li>
        <li>Credential authorized: {result.authorized ? 'yes' : 'no'}</li>
        {result.warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
      {result.status === 'healthy' && webhookPath && (
        <NativeWebhookInstructions type={type} webhookPath={webhookPath} />
      )}
      <SetupActions>
        <button
          type="button"
          onClick={onClose}
          className="sre-action sre-action-primary self-start"
        >
          Finish
        </button>
      </SetupActions>
    </div>
  );
}
