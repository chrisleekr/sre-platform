import { connectorConfigs, withTenant, type Db, type listIncidentSignals } from '@sre/db';
import { inArray } from 'drizzle-orm';
import { scrubSecrets } from '@sre/agent-tools';

/** Reports present lifecycle authority without rewriting historical observations. */
export async function publicSignalCoverage(
  db: Db,
  tenantId: string,
  signals: Awaited<ReturnType<typeof listIncidentSignals>>,
) {
  const lifecycleConnectorIds = [
    ...new Set(signals.flatMap((signal) => (signal.dataSourceId ? [signal.dataSourceId] : []))),
  ];
  const lifecycleConnectors = lifecycleConnectorIds.length
    ? await withTenant(db, tenantId, (tx) =>
        tx
          .select({
            id: connectorConfigs.id,
            enabled: connectorConfigs.enabled,
            deletedAt: connectorConfigs.deletedAt,
            lifecycleVersion: connectorConfigs.lifecycleVersion,
          })
          .from(connectorConfigs)
          .where(inArray(connectorConfigs.id, lifecycleConnectorIds)),
      )
    : [];
  return signals.map((signal) => {
    const verified = lifecycleConnectors.some(
      (connector) =>
        connector.id === signal.dataSourceId &&
        connector.enabled &&
        !connector.deletedAt &&
        connector.lifecycleVersion === signal.signalSource?.lifecycleVersion &&
        signal.signalSource?.kind === 'monitor',
    );
    return {
      ...signal,
      verifiedProviderState: verified ? signal.signalSource?.lifecycleState : undefined,
      lifecycleCoverage:
        signal.signalSource?.kind === 'human_report' ||
        signal.signalSource?.kind === 'platform_observer' ||
        (signal.surface !== 'slack' &&
          !['alertmanager', 'prometheus', 'statuscake', 'datadog', 'grafana'].includes(
            signal.provider ?? signal.surface,
          ))
          ? undefined
          : !(signal.dataSourceId && signal.providerFingerprint && signal.startsAt)
            ? 'binding_required'
            : verified
              ? 'verified'
              : 'reverification_required',
      alertName: signal.alertName ? scrubSecrets(signal.alertName) : signal.alertName,
    };
  });
}
