import {
  acceptAlertEpisodeIntake,
  getBindingByExternal,
  getSignalByProviderEpisode,
  threadExternalId,
} from '@sre/db';

import type { AlertmanagerWebhookDeps } from '../alertmanager-webhook';
import type { NormalizedAlert } from './normalize';

interface DeduplicatedEpisodeIntake {
  id: string;
  channel: string;
  rootMessageId: string | null;
}

/**
 * Finalizes a losing concurrent route against the winner's exact provider episode and Slack root.
 *
 * @param deps - Alertmanager persistence and routing dependencies.
 * @param connector - Tenant-scoped connector identity.
 * @param intake - Durable intake whose root must retain exact binding provenance.
 * @param alert - Provider episode identity shared with the winning route.
 */
export async function finalizeDeduplicatedEpisode(
  deps: AlertmanagerWebhookDeps,
  connector: { id: string; tenantId: string },
  intake: DeduplicatedEpisodeIntake,
  alert: NormalizedAlert,
): Promise<void> {
  const existing = await getSignalByProviderEpisode(
    deps.appDb,
    connector.tenantId,
    connector.id,
    alert.fingerprint,
    alert.startsAt,
  );
  if (!existing) throw new Error('provider episode route is temporarily deduplicated');
  if (!intake.rootMessageId) throw new Error('provider episode intake has no Slack root');
  const binding = await getBindingByExternal(
    deps.appDb,
    connector.tenantId,
    'slack',
    threadExternalId({ channel: intake.channel, threadId: intake.rootMessageId }),
  );
  if (!binding || binding.incidentId !== existing.incidentId)
    throw new Error('provider episode route has no exact source binding');
  if (
    !(await acceptAlertEpisodeIntake(
      deps.appDb,
      connector.tenantId,
      intake.id,
      existing.incidentId,
      binding.id,
    ))
  )
    throw new Error('provider episode intake acceptance conflicted');
}
