import {
  getDomainNotificationContext,
  getFoundingDomainChallenge,
  listOwners,
  verifyDomainProof,
  verifyFoundingDomainProof,
  type Db,
  type TxtResolver,
} from '@sre/db';
import type { Notifier } from '@sre/notifications';

/**
 * Notifies workspace owners when directory proof becomes actionable or verified.
 *
 * @param db - Control-plane database connection.
 * @param notifier - Durable notification service.
 * @param domainId - Checked directory-domain record.
 * @param status - Latest proof status returned by the verifier.
 */
export async function notifyDomainLifecycle(
  db: Db,
  notifier: Notifier,
  domainId: string,
  status: 'pending' | 'verified' | 'expired' | 'conflict',
): Promise<void> {
  if (status !== 'pending' && status !== 'verified') return;
  const context = await getDomainNotificationContext(db, domainId);
  if (!context) return;
  const expiring =
    status === 'pending' &&
    context.expiresAt !== null &&
    context.expiresAt.getTime() <= Date.now() + 24 * 60 * 60 * 1_000;
  if (status === 'pending' && !expiring) return;
  const kind = status === 'verified' ? 'directory.verified' : 'directory.expiring';
  const owners = await listOwners(db, context.tenantId);
  await Promise.all(
    owners.map((owner) =>
      notifier.notify(
        { userId: owner.userId },
        kind,
        { workspaceName: context.workspaceName, domain: context.domain },
        {
          tenantId: context.tenantId,
          eventKey: `directory:${domainId}:${status}:${owner.userId}`,
        },
      ),
    ),
  );
}

/** Creates the worker callback that verifies one proof and emits its durable lifecycle event. */
export function makeDomainLifecycleCheck(db: Db, notifier: Notifier, resolveTxt: TxtResolver) {
  return async (domainId: string, currentJobId?: string) => {
    const result = await verifyDomainProof(db, domainId, resolveTxt, currentJobId);
    await notifyDomainLifecycle(db, notifier, domainId, result.status);
    return result;
  };
}

/** Creates the founder-scoped manual proof callback with the same owner notifications. */
export function makeFoundingDomainLifecycleCheck(
  db: Db,
  notifier: Notifier,
  resolveTxt: TxtResolver,
) {
  return async (foundingId: string, founderUserId: string) => {
    const result = await verifyFoundingDomainProof(db, foundingId, founderUserId, resolveTxt);
    if (result?.status === 'verified' || result?.status === 'pending') {
      const domain = await getFoundingDomainChallenge(db, foundingId, founderUserId);
      if (domain) await notifyDomainLifecycle(db, notifier, domain.id, result.status);
    }
    return result;
  };
}
