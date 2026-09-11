import type { KubernetesSettings, KubernetesTestResult } from '../lib/connectors';

export const INSTALL_NAMESPACE = 'sre-triage';
export const SERVICE_ACCOUNT = 'sre-triage-reader';
export const STEPS = ['Cluster', 'Access', 'Credentials', 'Review', 'Verify'];
const RBAC_DELIMITER = 'SRE_PLATFORM_KUBERNETES_RBAC';

export interface KubernetesConnectWizardProps {
  mode: 'connect' | 'edit';
  connectorId?: string;
  initialName?: string;
  initialSettings?: Partial<KubernetesSettings>;
  credentialConfigured?: boolean;
  onFetchManifest: (args: { namespace: string; serviceAccount: string }) => Promise<string>;
  onSave: (body: {
    id?: string;
    name: string;
    settings: KubernetesSettings;
    credential?: string;
    enabled: boolean;
  }) => Promise<{ connectorId: string }>;
  onRunTest: (id: string) => Promise<KubernetesTestResult>;
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
}

export function isPrivateApiUrl(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (host.startsWith('127.') || host.startsWith('169.254.')) return true;
  if (host.startsWith('10.') || host.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return isInClusterHost(host);
}

/**
 * In-cluster service names resolve into private space but are not literal private addresses, so the
 * range checks above miss them. Treating them as public offers system trust, which then fails the
 * handshake against a cluster CA with nothing pointing at trust as the cause. The API server's own
 * names are included because monitoring the cluster the platform runs in is a supported setup.
 */
function isInClusterHost(host: string): boolean {
  if (host === 'kubernetes' || host === 'kubernetes.default') return true;
  return host.endsWith('.svc') || host.endsWith('.svc.cluster.local');
}

export function installCommand(manifest: string, verb: 'apply' | 'delete'): string {
  return `kubectl ${verb} -f - <<'${RBAC_DELIMITER}'\n${manifest.trimEnd()}\n${RBAC_DELIMITER}`;
}
