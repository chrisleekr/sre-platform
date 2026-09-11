import { requestErrorMessage } from '../lib/request-error';
import { argoCdUrlError } from '@sre/contracts';
import { useState } from 'react';
import type { ArgoCdAccessResult, ArgoCdSettings, ArgoCdTestResult } from '../lib/connectors';
import { SetupDialog } from './SetupDialog';
import { SetupProgress } from './SetupProgress';
import { ArgoCdReviewSteps } from './argocd-connect/ReviewSteps';
import { ArgoCdSetupSteps } from './argocd-connect/SetupSteps';
import type { ArgoCdWizardViewModel } from './argocd-connect/view-model';

const STEPS = ['Server', 'Projects', 'Access & tokens', 'Review', 'Verify'];
const LEGACY_ACCESS_ROLE = 'sre-platform';

function newAccessRole(): string {
  return `${LEGACY_ACCESS_ROLE}-${crypto.randomUUID().slice(0, 8)}`;
}

interface ApplicationDraft {
  name: string;
  namespace: string;
}

interface ProjectDraft {
  project: string;
  applications: ApplicationDraft[];
  token: string;
  credentialConfigured: boolean;
  access: ArgoCdAccessResult | null;
}

export interface ArgoCdConnectWizardProps {
  mode: 'connect' | 'edit';
  connectorId?: string;
  initialName?: string;
  initialSettings?: Partial<ArgoCdSettings>;
  onGenerateAccess: (body: {
    project: string;
    role: string;
    applicationsInAnyNamespace: boolean;
    applications: Array<{ name: string; namespace?: string }>;
  }) => Promise<ArgoCdAccessResult>;
  onSave: (body: {
    id?: string;
    name: string;
    settings: ArgoCdSettings;
    credentials?: Array<{ project: string; token: string }>;
    insecureTlsAcknowledged?: boolean;
    insecureHttpAcknowledged?: boolean;
  }) => Promise<{ connectorId: string }>;
  onRunTest: (id: string) => Promise<ArgoCdTestResult>;
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
}

function newProject(project = 'default'): ProjectDraft {
  return {
    project,
    applications: [{ name: '*', namespace: '*' }],
    token: '',
    credentialConfigured: false,
    access: null,
  };
}

export function ArgoCdConnectWizard({
  mode,
  connectorId,
  initialName,
  initialSettings,
  onGenerateAccess,
  onSave,
  onRunTest,
  returnFocusTo,
  onClose,
}: ArgoCdConnectWizardProps) {
  const [step, setStep] = useState(1);
  const [savedConnectorId, setSavedConnectorId] = useState(connectorId);
  const [savedAccessRole, setSavedAccessRole] = useState(
    mode === 'edit' ? (initialSettings?.accessRole ?? LEGACY_ACCESS_ROLE) : undefined,
  );
  const [accessMode, setAccessMode] = useState<'existing' | 'create'>('existing');
  const [dataSourceName, setDataSourceName] = useState(initialName ?? 'Argo CD');
  const [dedicatedRole] = useState(
    () =>
      initialSettings?.accessRole ?? (mode === 'connect' ? newAccessRole() : LEGACY_ACCESS_ROLE),
  );
  const [existingAccessRole, setExistingAccessRole] = useState(
    initialSettings?.accessRole ?? (mode === 'edit' ? LEGACY_ACCESS_ROLE : ''),
  );
  const accessRole =
    savedAccessRole ?? (accessMode === 'existing' ? existingAccessRole.trim() : dedicatedRole);
  const [baseUrl, setBaseUrl] = useState(initialSettings?.baseUrl ?? 'https://argocd.example.com');
  const [serverSubmitted, setServerSubmitted] = useState(false);
  const baseUrlError = serverSubmitted ? argoCdUrlError(baseUrl) : null;
  const usesHttp = /^http:/i.test(baseUrl.trim());
  const [httpAcknowledged, setHttpAcknowledged] = useState(false);
  const initialTrust = initialSettings?.insecureSkipTLSVerify
    ? 'insecure'
    : initialSettings?.caConfigured
      ? 'ca'
      : 'system';
  const [trust, setTrust] = useState<'system' | 'ca' | 'insecure'>(initialTrust);
  const [caCert, setCaCert] = useState('');
  const [insecureAcknowledged, setInsecureAcknowledged] = useState(false);
  const [applicationsInAnyNamespace, setApplicationsInAnyNamespace] = useState(
    initialSettings?.applicationsInAnyNamespace ?? false,
  );
  const [projects, setProjects] = useState<ProjectDraft[]>(() =>
    initialSettings?.projects?.length
      ? initialSettings.projects.map((binding) => ({
          project: binding.project,
          applications: binding.applications.map((scope) => ({
            name: scope.name,
            namespace: scope.namespace ?? '*',
          })),
          token: '',
          credentialConfigured: binding.credentialConfigured === true,
          access: null,
        }))
      : [newProject()],
  );
  const [labelSelector, setLabelSelector] = useState(initialSettings?.labelSelector ?? '');
  const [busyProject, setBusyProject] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ArgoCdTestResult | null>(null);

  const normalizedProjects = projects.map((binding) => ({
    project: binding.project.trim(),
    applications: binding.applications.map((scope) => ({
      name: scope.name.trim(),
      ...(applicationsInAnyNamespace ? { namespace: scope.namespace.trim() } : {}),
    })),
  }));
  const serverChanged =
    mode === 'edit' &&
    initialSettings?.baseUrl !== undefined &&
    baseUrl.trim() !== initialSettings.baseUrl;

  const continueFromServer = (): void => {
    if (!dataSourceName.trim()) {
      setError('Data source name is required.');
      return;
    }
    setServerSubmitted(true);
    if (argoCdUrlError(baseUrl)) {
      setError('');
      return;
    }
    if (usesHttp && !httpAcknowledged) {
      setError('Acknowledge the unencrypted HTTP transport before continuing.');
      return;
    }
    if (!usesHttp && trust === 'ca' && !caCert.trim() && !initialSettings?.caConfigured) {
      setError('Paste the CA certificate, or choose system trust.');
      return;
    }
    if (!usesHttp && trust === 'insecure' && !insecureAcknowledged) {
      setError('Acknowledge the insecure TLS risk before continuing.');
      return;
    }
    setError('');
    setStep(2);
  };

  const continueFromProjects = (): void => {
    const names = normalizedProjects.map((binding) => binding.project);
    const totalScopes = normalizedProjects.reduce(
      (total, binding) => total + binding.applications.length,
      0,
    );
    if (
      names.some((project) => !project) ||
      new Set(names).size !== names.length ||
      normalizedProjects.some((binding) =>
        binding.applications.some(
          (scope) => !scope.name || (applicationsInAnyNamespace && !scope.namespace),
        ),
      )
    ) {
      setError('Each project must be unique and every application scope must be complete.');
      return;
    }
    if (totalScopes > 50) {
      setError('Use at most 50 application scopes across all projects.');
      return;
    }
    setError('');
    setStep(3);
  };

  const generateAccess = (index: number): void => {
    const binding = normalizedProjects[index];
    if (!binding) return;
    setBusyProject(index);
    setError('');
    void onGenerateAccess({
      project: binding.project,
      role: accessRole,
      applicationsInAnyNamespace,
      applications: binding.applications,
    })
      .then((access) =>
        setProjects((current) =>
          current.map((project, projectIndex) =>
            projectIndex === index ? { ...project, access } : project,
          ),
        ),
      )
      .catch((cause) =>
        setError(
          requestErrorMessage(cause, `Access generation failed for project ${binding.project}.`),
        ),
      )
      .finally(() => setBusyProject(null));
  };

  const continueFromCredentials = (): void => {
    if (
      !accessRole ||
      accessRole.length > 63 ||
      !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(accessRole)
    ) {
      setError(
        'Enter the project role name, using up to 63 lowercase letters, numbers, dots, or hyphens.',
      );
      return;
    }
    if (mode === 'connect' && !savedConnectorId && accessRole === LEGACY_ACCESS_ROLE) {
      setError(
        'The legacy sre-platform role is reserved for existing connections. Manage that connection or use a separate dedicated role.',
      );
      return;
    }
    const missing = projects.find(
      (binding) => !binding.token.trim() && (serverChanged || !binding.credentialConfigured),
    );
    if (missing) {
      setError(`Paste a project-role token for project ${missing.project || '(unnamed)'}.`);
      return;
    }
    setError('');
    setStep(4);
  };

  const saveAndVerify = (): void => {
    setBusy(true);
    setSubmitted(true);
    setError('');
    void (async () => {
      try {
        const saved = await onSave({
          ...(savedConnectorId ? { id: savedConnectorId } : {}),
          name: dataSourceName.trim(),
          settings: {
            baseUrl: baseUrl.trim(),
            accessRole,
            applicationsInAnyNamespace,
            projects: normalizedProjects,
            ...(labelSelector.trim() ? { labelSelector: labelSelector.trim() } : {}),
            ...(!usesHttp && trust === 'ca'
              ? caCert.trim()
                ? { caCert: caCert.trim() }
                : {}
              : initialSettings?.caConfigured
                ? { caCert: '' }
                : {}),
            ...(!usesHttp && trust === 'insecure' ? { insecureSkipTLSVerify: true } : {}),
          },
          credentials: projects.flatMap((binding) =>
            binding.token.trim()
              ? [{ project: binding.project.trim(), token: binding.token.trim() }]
              : [],
          ),
          ...(!usesHttp && trust === 'insecure' ? { insecureTlsAcknowledged: true } : {}),
          ...(usesHttp && httpAcknowledged ? { insecureHttpAcknowledged: true } : {}),
        });
        setSavedConnectorId(saved.connectorId);
        setSavedAccessRole(accessRole);
        setResult(await onRunTest(saved.connectorId));
        setStep(5);
      } catch (cause) {
        setError(
          requestErrorMessage(
            cause,
            'Save or verification failed. The disabled draft may already exist; review the project results and retry.',
          ),
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  const view: ArgoCdWizardViewModel = {
    mode,
    initialSettings,
    step,
    setStep,
    dataSourceName,
    setDataSourceName,
    accessRole,
    accessMode,
    accessRoleLocked: mode === 'edit' || Boolean(savedConnectorId),
    chooseAccessMode: (next) => {
      setAccessMode(next);
      if (mode === 'connect' && !savedConnectorId) {
        setProjects((current) =>
          current.map((binding) => ({ ...binding, token: '', access: null })),
        );
      } else {
        setProjects((current) => current.map((binding) => ({ ...binding, access: null })));
      }
    },
    setExistingAccessRole: (value) => {
      setExistingAccessRole(value);
      setProjects((current) => current.map((binding) => ({ ...binding, token: '', access: null })));
    },
    baseUrl,
    baseUrlError,
    usesHttp,
    httpAcknowledged,
    setHttpAcknowledged: (value) => {
      setHttpAcknowledged(value);
      setError('');
    },
    setBaseUrl: (value) => {
      setBaseUrl(value);
      setHttpAcknowledged(false);
    },
    trust,
    setTrust,
    caCert,
    setCaCert,
    insecureAcknowledged,
    setInsecureAcknowledged,
    applicationsInAnyNamespace,
    setApplicationsInAnyNamespace,
    projects,
    setProjects,
    labelSelector,
    setLabelSelector,
    busyProject,
    busy,
    submitted,
    error,
    result,
    normalizedProjects,
    serverChanged,
    continueFromServer,
    continueFromProjects,
    generateAccess,
    continueFromCredentials,
    saveAndVerify,
    onClose,
  };

  return (
    <SetupDialog
      title={mode === 'edit' ? 'Manage Argo CD' : 'Connect Argo CD'}
      closeLabel={submitted || mode === 'edit' ? 'Close' : 'Cancel'}
      busy={busy || busyProject !== null}
      returnFocusTo={returnFocusTo}
      onClose={onClose}
    >
      <SetupProgress steps={STEPS} current={step} />
      <ArgoCdSetupSteps view={view} />
      <ArgoCdReviewSteps view={view} />
    </SetupDialog>
  );
}
