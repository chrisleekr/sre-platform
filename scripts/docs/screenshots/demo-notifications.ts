import { createNotification } from '../../../packages/db/src/index';
import type { DemoSeedDeps } from './demo-environment';

/** Seeds a small, realistic inbox for responsive documentation captures. */
export async function seedNotifications(deps: DemoSeedDeps): Promise<void> {
  const events = [
    {
      kind: 'directory.verified',
      payload: { workspaceName: 'Acme Engineering', domain: 'example.test' },
      eventKey: 'demo:directory:verified',
    },
    {
      kind: 'workspace.ownership_transferred',
      payload: { workspaceName: 'Acme Engineering' },
      eventKey: 'demo:workspace:ownership',
    },
  ] as const;

  for (const event of events) {
    await createNotification(deps.adminDb, {
      recipientUserId: deps.userId,
      tenantId: deps.tenantId,
      ...event,
    });
  }
}
