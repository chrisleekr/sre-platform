import { config } from '../../config';
import { publicApiOrigin, publicWebhookUrl } from './event-delivery';
import { PublicDeliveryNotice, WebhookInstructions } from './WebhookInstructions';

/** Shows saved native endpoints without displaying event credentials. */
export function NativeWebhookInstructions({
  type,
  webhookPath,
}: {
  type: 'datadog' | 'grafana';
  webhookPath: string;
}) {
  const origin = publicApiOrigin(config.apiBaseUrl);
  return (
    <div className="min-w-0 space-y-3">
      <PublicDeliveryNotice available={Boolean(origin)} />
      <WebhookInstructions
        provider={type === 'datadog' ? 'Datadog' : 'Grafana'}
        url={publicWebhookUrl(origin, webhookPath)}
      />
    </div>
  );
}
