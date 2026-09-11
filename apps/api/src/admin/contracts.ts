import type { Db, PlatformSecretStore } from '@sre/db';
import type { Notifier } from '@sre/notifications';
import type { PlatformSettings } from '@sre/platform-settings';
import type { AuthDeps, AuthVariables } from '../auth';
import type { FoundingQueuePort } from '../onboarding/contracts';

export interface AdminRoutesDeps {
  auth: AuthDeps;
  appDb: Db;
  controlDb: Db;
  clientSecrets?: PlatformSecretStore;
  queue?: FoundingQueuePort;
  notifier?: Notifier;
  settings: Pick<PlatformSettings, 'get' | 'set'>;
}

export type AdminVariables = AuthVariables;
