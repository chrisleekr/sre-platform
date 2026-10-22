import { isIP } from 'node:net';
import { entityCandidateKey, type AffectedEntityCandidate } from '@sre/contracts';

const LABEL = '[a-z0-9](?:[-a-z0-9]*[a-z0-9])?';
const NAME = '[a-z0-9](?:[-.a-z0-9]*[a-z0-9])?';
const WORKLOAD = new RegExp(
  `\\b(Deployment|Pod|Job|StatefulSet|DaemonSet|CronJob) (${LABEL})/(${NAME})(?![\\w/-])`,
  'g',
);
// Same line only, so a namespace in one alert never pairs with a pod in another.
const NAMESPACE_POD = new RegExp(
  `\\bnamespace (${LABEL})\\b[^\\n]{0,120}?\\bpod (${NAME})(?![\\w/-])`,
  'g',
);
// kube-prometheus KubeContainerWaiting prints `pod/<name> in namespace <ns>`.
const POD_IN_NAMESPACE = new RegExp(`\\bpod[/ ](${NAME}) in namespace (${LABEL})\\b`, 'g');
const SERVICE_DNS = new RegExp(`\\b(${LABEL})\\.(${LABEL})\\.svc\\.cluster\\.local\\b`, 'g');
const ADDRESS = /\b(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}\b/g;

/**
 * Reads exact Kubernetes identities that Alertmanager descriptions print, never the Slack heading,
 * whose namespace label belongs to the exporter rather than the affected resource.
 * @param summary - Alert text carried by one Slack observation.
 * @param observedAt - Event time of that observation.
 */
export function alertEntityCandidates(
  summary: string,
  observedAt: Date,
): AffectedEntityCandidate[] {
  // Label patterns backtrack quadratically on long hyphen runs, so the scan is length-bounded.
  const text = summary.slice(0, 4096);
  const found: Array<[AffectedEntityCandidate['kind'], string, Record<string, string>, string]> =
    [];
  for (const [, kind, namespace, name] of text.matchAll(WORKLOAD))
    found.push(['workload', name!, { namespace: namespace! }, `${kind} ${namespace}/${name}`]);
  for (const [, namespace, name] of text.matchAll(NAMESPACE_POD))
    found.push(['workload', name!, { namespace: namespace! }, `Pod ${namespace}/${name}`]);
  for (const [, name, namespace] of text.matchAll(POD_IN_NAMESPACE))
    found.push(['workload', name!, { namespace: namespace! }, `Pod ${namespace}/${name}`]);
  for (const [host, name, namespace] of text.matchAll(SERVICE_DNS))
    found.push(['endpoint', name!, { namespace: namespace! }, host]);
  // A bare scrape address is the weakest identity, so it only stands in when nothing named the resource.
  if (!found.length)
    for (const [, address] of text.matchAll(ADDRESS))
      if (isIP(address!) === 4) found.push(['node', address!, {}, address!]);
  const candidates = new Map<string, AffectedEntityCandidate>();
  for (const [kind, stableId, scope, displayName] of found) {
    const key = entityCandidateKey(kind, stableId, scope);
    if (candidates.has(key)) continue;
    candidates.set(key, {
      key,
      kind,
      stableId,
      displayName,
      scope,
      provenance: { kind: 'provider_label', source: 'alert_text' },
      confidence: 70,
      observedAt: observedAt.toISOString(),
      completeness: 'partial',
      requiredCapabilities:
        kind === 'endpoint' ? ['availability', 'metrics', 'logs'] : ['runtime', 'metrics', 'logs'],
    });
  }
  return [...candidates.values()].slice(0, 5);
}
