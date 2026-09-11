import { requestErrorMessage } from '../lib/request-error';
import type { PrepareDelivery } from '../lib/connector-delivery';
import type { GitLabManagementApi } from '../lib/connector-api/gitlab-management';
import { GitLabManagementPanel } from './gitlab-connect/ManagementPanel';
import { GitLabDiscoveryRequestError } from '../lib/connector-api/gitlab';
import { usePreparedDelivery } from './connector-setup/usePreparedDelivery';
import { DeliveryPreparationStatus } from './connector-setup/DeliveryPreparationStatus';
import { useEffect, useMemo, useState } from 'react';
import type { GitLabDiscovery, GitLabSettings, GitLabTestResult } from '../lib/connectors';
import { SetupDialog } from './SetupDialog';
import { SetupProgress } from './SetupProgress';
import { GitLabReviewSteps } from './gitlab-connect/ReviewSteps';
import { GitLabSetupSteps } from './gitlab-connect/SetupSteps';
import {
  PUBLIC_API_CONFIGURATION_ERROR,
  publicApiOrigin,
  publicWebhookUrl,
} from './connector-setup/event-delivery';
import type { GitLabWizardViewModel } from './gitlab-connect/view-model';
import { savedHookScope, type HookScope } from './gitlab-connect/support';

const STEPS = ['Scope & access', 'Projects', 'Events', 'Review', 'Verify'];
type EventTransport = 'direct' | 'smee' | 'none';

function randomWebhookSigningToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${btoa(String.fromCharCode(...bytes))}`;
}

function validGroupPath(value: string): boolean {
  return (
    value.length > 0 && value.length <= 255 && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value)
  );
}

function validDeliveryUrl(value: string, mode: Exclude<EventTransport, 'none'>): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (mode === 'smee' ? url.hostname === 'smee.io' : url.pathname === '/')
    );
  } catch {
    return false;
  }
}

function supportsWebhookSigningToken(version: string | undefined): boolean {
  const match = version?.match(/^(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 19 || (major === 19 && minor >= 1);
}

export interface GitLabConnectWizardProps {
  managementApi?: GitLabManagementApi;
  mode: 'connect' | 'edit';
  connectorId?: string;
  initialName?: string;
  apiBaseUrl: string;
  initialSettings?: Partial<GitLabSettings>;
  initialWebhookPath?: string;
  credentialConfigured?: boolean;
  onDiscover: (body: {
    dataSourceId?: string;
    baseUrl: string;
    groupPath: string;
    credential?: string;
  }) => Promise<GitLabDiscovery>;
  onPrepareDelivery: PrepareDelivery;
  onSave: (body: {
    setupId?: string;
    id?: string;
    name: string;
    settings: GitLabSettings;
    credential?: string;
    webhookSigningToken?: string;
  }) => Promise<{
    connectorId: string;
    name: string;
    webhookPath?: string;
    relayStatus?: 'connected' | 'stopped' | 'failed';
  }>;
  onRunTest: (id: string) => Promise<GitLabTestResult>;
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
}

export function GitLabConnectWizard({
  managementApi,
  mode,
  connectorId,
  initialName,
  apiBaseUrl,
  initialSettings,
  initialWebhookPath,
  credentialConfigured = false,
  onDiscover,
  onPrepareDelivery,
  onSave,
  onRunTest,
  returnFocusTo,
  onClose,
}: GitLabConnectWizardProps) {
  const [step, setStep] = useState(1);
  const [dataSourceId, setDataSourceId] = useState(connectorId);
  const [dataSourceName, setDataSourceName] = useState(initialName ?? 'GitLab');
  const [baseUrl, setBaseUrl] = useState(initialSettings?.baseUrl ?? 'https://gitlab.com');
  const [groupPath, setGroupPath] = useState(initialSettings?.groupPath ?? '');
  const [credential, setCredential] = useState('');
  const [discovery, setDiscovery] = useState<GitLabDiscovery | null>(null);
  const [eventTransport, setEventTransport] = useState<EventTransport>(
    initialSettings?.eventTransport ?? 'none',
  );
  const [hookScope, setHookScope] = useState<HookScope>(
    savedHookScope(initialSettings) ?? 'projects',
  );
  const [smeeUrl, setDeliveryUrl] = useState('');
  const [managedProjects, setManagedProjects] = useState(
    initialSettings?.eventStrategy === 'managed_projects',
  );
  const deliveryUrl = eventTransport === 'direct' ? publicApiOrigin(apiBaseUrl) : smeeUrl;
  const [webhookSigningToken, setWebhookSigningToken] = useState('');
  const [webhookPath, setWebhookPath] = useState(initialWebhookPath ?? '');

  const preparation = usePreparedDelivery({
    transport: eventTransport,
    hasSmeeUrl: Boolean(smeeUrl.trim()),
    existing: Boolean(dataSourceId),
    storedSmee:
      initialSettings?.eventTransport === 'smee' && Boolean(initialSettings.smeeConfigured),
    initialPath: initialWebhookPath,
    prepare: onPrepareDelivery,
  });
  useEffect(() => {
    if (preparation.smeeUrl) setDeliveryUrl((current) => current || preparation.smeeUrl!);
  }, [preparation.smeeUrl]);
  const [relayStatus, setRelayStatus] = useState<'connected' | 'stopped' | 'failed' | undefined>();
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<GitLabTestResult | null>(null);

  const sampleProjects = useMemo(() => discovery?.projects.slice(0, 8) ?? [], [discovery]);
  const legacy = initialSettings?.projectId !== undefined && initialSettings.groupId === undefined;
  const canConfigureSignedWebhooks = supportsWebhookSigningToken(discovery?.instance?.version);
  const signedWebhooksSupported =
    canConfigureSignedWebhooks || initialSettings?.webhookSigningTokenConfigured === true;
  const eventSetupUnavailable =
    !signedWebhooksSupported && initialSettings?.webhookSecretConfigured !== true;

  const chooseEventTransport = (transport: EventTransport): void => {
    if (
      transport !== 'none' &&
      !signedWebhooksSupported &&
      !initialSettings?.webhookSecretConfigured
    ) {
      setError(
        'Authenticated event sync requires GitLab 19.1 or newer. Configure it later or upgrade GitLab.',
      );
      return;
    }
    setEventTransport(transport);
    setError('');
    if (
      transport !== 'none' &&
      !webhookSigningToken &&
      !initialSettings?.webhookSigningTokenConfigured &&
      !initialSettings?.webhookSecretConfigured
    )
      setWebhookSigningToken(randomWebhookSigningToken());
  };

  const discover = (): void => {
    if (!dataSourceName.trim()) {
      setError('Data source name is required.');
      return;
    }
    if (!validGroupPath(groupPath.trim())) {
      setError('Enter the top-level group full path, for example platform or acme/platform.');
      return;
    }
    try {
      const url = new URL(baseUrl.trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
        throw new Error('invalid URL');
    } catch {
      setError('Enter a valid HTTPS GitLab URL without credentials, a query, or a fragment.');
      return;
    }
    if (mode === 'connect' && !credential.trim()) {
      setError('Paste the read-only group token before checking access.');
      return;
    }
    if (mode === 'edit' && !credential.trim() && !credentialConfigured) {
      setError('The stored credential is missing. Paste a replacement token.');
      return;
    }
    setBusy(true);
    setError('');
    void onDiscover({
      ...(connectorId ? { dataSourceId: connectorId } : {}),
      baseUrl: baseUrl.trim(),
      groupPath: groupPath.trim(),
      ...(credential.trim() ? { credential: credential.trim() } : {}),
    })
      .then((found) => {
        if (found.projects.length === 0) {
          setError('The group is readable, but it contains no projects this token can diagnose.');
          return;
        }
        setDiscovery(found);
        setGroupPath(found.group.fullPath);
        if (
          !supportsWebhookSigningToken(found.instance?.version) &&
          !initialSettings?.webhookSigningTokenConfigured &&
          !initialSettings?.webhookSecretConfigured
        ) {
          setEventTransport('none');
          setWebhookSigningToken('');
        }
        setStep(2);
      })
      .catch((failure: unknown) =>
        setError(
          failure instanceof GitLabDiscoveryRequestError
            ? failure.message
            : 'Discovery could not complete. Retry, or ask your administrator to check API connectivity to GitLab.',
        ),
      )
      .finally(() => setBusy(false));
  };

  const reviewEvents = (): void => {
    if (eventTransport !== 'none') {
      if (webhookSigningToken && !canConfigureSignedWebhooks) {
        setError('GitLab 19.1 or newer is required to configure an HMAC signing token.');
        return;
      }
      if (!signedWebhooksSupported && !initialSettings?.webhookSecretConfigured) {
        setError('Authenticated event sync requires GitLab 19.1 or newer.');
        return;
      }
      const keepsSmeeChannel =
        mode === 'edit' &&
        eventTransport === 'smee' &&
        initialSettings?.eventTransport === 'smee' &&
        initialSettings.smeeConfigured &&
        !deliveryUrl.trim();
      if (!keepsSmeeChannel && !validDeliveryUrl(deliveryUrl.trim(), eventTransport)) {
        setError(
          eventTransport === 'smee'
            ? 'Enter an https://smee.io channel URL.'
            : PUBLIC_API_CONFIGURATION_ERROR,
        );
        return;
      }
      if (
        !webhookSigningToken &&
        !initialSettings?.webhookSigningTokenConfigured &&
        !initialSettings?.webhookSecretConfigured
      ) {
        setError('Generate a GitLab signing token before continuing.');
        return;
      }
    }
    setError('');
    setStep(4);
  };

  const saveAndVerify = (): void => {
    if (
      eventTransport !== 'none' &&
      (preparation.busy || preparation.error || (!dataSourceId && !preparation.setupId))
    ) {
      setError('Wait for webhook preparation, or retry it before continuing.');
      return;
    }

    if (!discovery) return;
    setBusy(true);
    setSubmitted(true);
    setError('');
    void (async () => {
      try {
        const saved = await onSave({
          ...(!dataSourceId && preparation.setupId ? { setupId: preparation.setupId } : {}),
          ...(dataSourceId ? { id: dataSourceId } : {}),
          name: dataSourceName.trim(),
          settings: {
            baseUrl: baseUrl.trim(),
            groupId: discovery.group.id,
            groupPath: discovery.group.fullPath,
            groupName: discovery.group.name,
            eventTransport,
            ...(hookScope === 'system'
              ? { eventStrategy: 'system' as const }
              : {
                  hookScope,
                  ...(hookScope === 'projects' && managedProjects
                    ? { eventStrategy: 'managed_projects' as const }
                    : {}),
                  ...(hookScope === 'group' ? { eventStrategy: 'group' as const } : {}),
                }),
            ...(eventTransport === 'smee' && deliveryUrl.trim()
              ? { smeeUrl: deliveryUrl.trim() }
              : {}),
          },
          ...(credential.trim() ? { credential: credential.trim() } : {}),
          ...(eventTransport !== 'none' && webhookSigningToken ? { webhookSigningToken } : {}),
        });
        setDataSourceId(saved.connectorId);
        if (saved.webhookPath) setWebhookPath(saved.webhookPath);
        setRelayStatus(saved.relayStatus);
        setResult(await onRunTest(saved.connectorId));
        setStep(5);
      } catch (cause) {
        setError(
          requestErrorMessage(
            cause,
            'Save or verification failed. The disabled draft may already exist; review the values and retry.',
          ),
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  const eventEndpoint = publicWebhookUrl(deliveryUrl, webhookPath || preparation.webhookPath || '');
  const providerWebhookUrl = eventTransport === 'smee' ? deliveryUrl.trim() : eventEndpoint;
  const webhookName =
    dataSourceId || preparation.setupId
      ? `SRE Platform ${(dataSourceId || preparation.setupId)!.slice(0, 8)}`
      : '';
  const webhookInstallCommand = (() => {
    const hookIdentity = dataSourceId || preparation.setupId;
    if (
      !hookIdentity ||
      !discovery ||
      !providerWebhookUrl ||
      !(webhookSigningToken || initialSettings?.webhookSigningTokenConfigured)
    )
      return '';
    const host = new URL(baseUrl).host;
    const hookName = webhookName;
    const common = {
      url: providerWebhookUrl,
      name: hookName,
      description: 'Authenticated change and deployment evidence for incident diagnosis',
      push_events: true,
      tag_push_events: true,
      merge_requests_events: true,
      enable_ssl_verification: true,
    };
    const tokenPrompt =
      "IFS= read -r -s -p 'Paste the GitLab webhook signing token: ' SRE_PLATFORM_GITLAB_SIGNING_TOKEN </dev/tty\n" +
      "printf '\\n' >/dev/tty";
    const bashScript = (body: string): string =>
      `bash <<'SRE_PLATFORM_GITLAB_SETUP'\nset -euo pipefail\nset +x\n${body}\nSRE_PLATFORM_GITLAB_SETUP`;
    const signedJson = (payload: string): string =>
      `jq --rawfile signing_token /dev/fd/3 '. + {signing_token: ($signing_token | rtrimstr("\\n"))}' 3<<<"$SRE_PLATFORM_GITLAB_SIGNING_TOKEN" <<'SRE_PLATFORM_GITLAB_WEBHOOK' |` +
      `\n${payload}\nSRE_PLATFORM_GITLAB_WEBHOOK`;
    if (hookScope === 'projects') {
      const payload = JSON.stringify(
        {
          ...common,
          pipeline_events: true,
          job_events: true,
          deployment_events: true,
          releases_events: true,
          resource_access_token_events: true,
        },
        null,
        2,
      );
      return bashScript(
        `${tokenPrompt}\nfor project_id in ${discovery.projects.map((project) => project.id).join(' ')}; do\n  hook_id="$(glab api --hostname ${host} --paginate "projects/\${project_id}/hooks" | jq -rs '[.[][] | select(.name == ${JSON.stringify(hookName)}) | .id][0] // empty')"\n  if [ -n "$hook_id" ]; then\n    method=PUT\n    endpoint="projects/\${project_id}/hooks/\${hook_id}"\n  else\n    method=POST\n    endpoint="projects/\${project_id}/hooks"\n  fi\n  ${signedJson(payload)}\n    glab api --hostname ${host} --method "$method" "$endpoint" --header 'content-type: application/json' --input - --silent\ndone\nunset SRE_PLATFORM_GITLAB_SIGNING_TOKEN`,
      );
    }
    const hookEndpoint = hookScope === 'system' ? 'hooks' : `groups/${discovery.group.id}/hooks`;
    const payload = JSON.stringify(
      hookScope === 'system'
        ? {
            ...common,
            repository_update_events: true,
            branch_filter_strategy: 'all_branches',
            push_events_branch_filter: '',
          }
        : {
            ...common,
            pipeline_events: true,
            job_events: true,
            deployment_events: true,
            releases_events: true,
            project_events: true,
            subgroup_events: true,
            resource_access_token_events: true,
          },
      null,
      2,
    );
    return bashScript(
      `${tokenPrompt}\nhook_id="$(glab api --hostname ${host} --paginate '${hookEndpoint}' | jq -rs '[.[][] | select(.name == ${JSON.stringify(hookName)}) | .id][0] // empty')"\nif [ -n "$hook_id" ]; then\n  method=PUT\n  endpoint="${hookEndpoint}/\${hook_id}"\nelse\n  method=POST\n  endpoint='${hookEndpoint}'\nfi\n${signedJson(payload)}\n  glab api --hostname ${host} --method "$method" "$endpoint" --header 'content-type: application/json' --input - --silent\nunset SRE_PLATFORM_GITLAB_SIGNING_TOKEN`,
    );
  })();

  const view: GitLabWizardViewModel = {
    mode,
    initialSettings,
    credentialConfigured,
    step,
    setStep,
    dataSourceId,
    dataSourceName,
    setDataSourceName,
    baseUrl,
    setBaseUrl,
    groupPath,
    setGroupPath,
    credential,
    setCredential,
    discovery,
    eventTransport,
    hookScope,
    setHookScope,
    managedProjects,
    setManagedProjects,
    deliveryUrl,
    setDeliveryUrl,
    webhookSigningToken,
    setWebhookSigningToken,
    relayStatus,
    busy,
    submitted,
    error,
    result,
    sampleProjects,
    legacy,
    signedWebhooksSupported,
    canConfigureSignedWebhooks,
    eventSetupUnavailable,
    chooseEventTransport,
    discover,
    reviewEvents,
    saveAndVerify,
    eventEndpoint,
    providerWebhookUrl,
    webhookInstallCommand,
    webhookName,
    onClose,
  };

  return (
    <SetupDialog
      title={mode === 'edit' ? 'Manage GitLab' : 'Connect GitLab'}
      closeLabel={submitted || mode === 'edit' ? 'Close' : 'Cancel'}
      busy={busy}
      returnFocusTo={returnFocusTo}
      onClose={onClose}
    >
      <SetupProgress steps={STEPS} current={step} />
      <DeliveryPreparationStatus
        busy={preparation.busy}
        error={preparation.error}
        retry={preparation.retry}
      />
      <GitLabSetupSteps view={view} />
      <GitLabReviewSteps view={view} />
      {managementApi &&
        dataSourceId &&
        ((step === 5 &&
          hookScope === 'projects' &&
          managedProjects &&
          result?.status === 'healthy') ||
          (step === 1 && initialSettings?.eventStrategy === 'managed_projects')) && (
          <GitLabManagementPanel
            api={managementApi}
            connectorId={dataSourceId}
            destination={eventEndpoint}
          />
        )}
    </SetupDialog>
  );
}
