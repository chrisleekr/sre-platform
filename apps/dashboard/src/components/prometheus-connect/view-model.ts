import type { Dispatch, SetStateAction } from 'react';
import type {
  ConnectorTestResult,
  PrometheusAuthType,
  PrometheusSettings,
} from '../../lib/connectors';

export interface PrometheusWizardViewModel {
  mode: 'connect' | 'edit';
  initialSettings?: Partial<PrometheusSettings>;
  credentialConfigured: boolean;
  step: number;
  setStep: Dispatch<SetStateAction<number>>;
  dataSourceName: string;
  setDataSourceName: Dispatch<SetStateAction<string>>;
  baseUrl: string;
  setBaseUrl: Dispatch<SetStateAction<string>>;
  authType: PrometheusAuthType;
  setAuthType: Dispatch<SetStateAction<PrometheusAuthType>>;
  trust: 'system' | 'ca' | 'insecure';
  setTrust: Dispatch<SetStateAction<'system' | 'ca' | 'insecure'>>;
  insecureAcknowledged: boolean;
  setInsecureAcknowledged: Dispatch<SetStateAction<boolean>>;
  httpAcknowledged: boolean;
  setHttpAcknowledged: Dispatch<SetStateAction<boolean>>;
  caCert: string;
  setCaCert: Dispatch<SetStateAction<string>>;
  token: string;
  setToken: Dispatch<SetStateAction<string>>;
  username: string;
  setUsername: Dispatch<SetStateAction<string>>;
  password: string;
  setPassword: Dispatch<SetStateAction<string>>;
  headerName: string;
  setHeaderName: Dispatch<SetStateAction<string>>;
  headerValue: string;
  setHeaderValue: Dispatch<SetStateAction<string>>;
  clientCert: string;
  setClientCert: Dispatch<SetStateAction<string>>;
  clientKey: string;
  setClientKey: Dispatch<SetStateAction<string>>;
  busy: boolean;
  submitted: boolean;
  error: string;
  result: ConnectorTestResult | null;
  eventTransport: 'direct' | 'smee' | 'none';
  setEventTransport: Dispatch<SetStateAction<'direct' | 'smee' | 'none'>>;
  alertChannel: string;
  setAlertChannel: Dispatch<SetStateAction<string>>;
  channels: Array<{ id: string; name: string }>;
  channelsError: string;
  smeeUrl: string;
  setSmeeUrl: Dispatch<SetStateAction<string>>;
  eventToken: string;
  setEventToken: Dispatch<SetStateAction<string>>;
  eventTokenVisible: boolean;
  setEventTokenVisible: Dispatch<SetStateAction<boolean>>;
  canKeepCredential: boolean;
  usesHttp: boolean;
  usesHttps: boolean;
  showTls: boolean;
  needsCa: boolean;
  continueFromEndpoint: () => void;
  continueFromCredentials: () => void;
  continueFromAlertDelivery: () => void;
  saveAndVerify: () => void;
  deliveryUrl: string;
  webhookYaml: string;
  webhookPath: string;
  onClose: () => void;
}
