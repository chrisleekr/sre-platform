import type { Dispatch, SetStateAction } from 'react';
import type {
  GitHubInstallationSummary,
  GitHubSettings,
  GitHubTestResult,
} from '../../lib/connectors';
import type { DeliveryMode, Owner, SetupPath } from './support';

export interface GitHubWizardViewModel {
  mode: 'connect' | 'edit';
  eventFailureCategory?: string | null;
  initialSettings?: Partial<GitHubSettings>;
  step: number;
  setStep: Dispatch<SetStateAction<number>>;
  dataSourceId?: string;
  dataSourceName: string;
  setDataSourceName: Dispatch<SetStateAction<string>>;
  setupPath: SetupPath;
  setSetupPath: Dispatch<SetStateAction<SetupPath>>;
  owner: Owner;
  setOwner: Dispatch<SetStateAction<Owner>>;
  organization: string;
  setOrganization: Dispatch<SetStateAction<string>>;
  deliveryMode: DeliveryMode;
  setDeliveryMode: (mode: DeliveryMode) => void;
  deliveryUrl: string;
  setDeliveryUrl: Dispatch<SetStateAction<string>>;
  appId: string;
  setAppId: Dispatch<SetStateAction<string>>;
  appSlug: string;
  privateKey: string;
  setPrivateKey: Dispatch<SetStateAction<string>>;
  webhookSecret: string;
  setWebhookSecret: Dispatch<SetStateAction<string>>;
  installUrl: string;
  relayStatus?: 'connected' | 'stopped' | 'failed';
  installations: GitHubInstallationSummary[];
  installationId: string;
  setInstallationId: Dispatch<SetStateAction<string>>;
  busy: boolean;
  submitted: boolean;
  error: string;
  result: GitHubTestResult | null;
  selectedInstallation?: GitHubInstallationSummary;
  writePermissions: string[];
  startManifest: () => void;
  discoverInstallations: () => void;
  review: () => void;
  saveAndVerify: () => void;
  eventEndpoint: string;
  onClose: () => void;
}
