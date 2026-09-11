import { and, eq, gt, inArray, lt, notExists, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import type { InsertFoundingJobTx } from './founding-repo';
import { identityProviders, jobs, platformSecrets, workspaceFoundings } from './schema';

/**
 * Atomically expires abandoned foundings and removes their provisional providers and queued work.
 *
 * @param db - Control-plane database connection.
 * @param slug - Limits cleanup to the address being registered; omitted by the background worker.
 */
export async function expireWorkspaceFoundings(db: Db, slug?: string): Promise<number> {
  return db.transaction(async (tx) => {
    await tx
      .update(workspaceFoundings)
      .set({
        status: 'awaiting_founder',
        authAttemptId: null,
        authAttemptStartedAt: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          slug === undefined ? undefined : eq(workspaceFoundings.slug, slug),
          eq(workspaceFoundings.status, 'authenticating_founder'),
          gt(workspaceFoundings.expiresAt, sql`clock_timestamp()`),
          lt(workspaceFoundings.authAttemptStartedAt, sql`clock_timestamp() - interval '1 minute'`),
        ),
      );
    const candidates = await tx
      .select({
        id: workspaceFoundings.id,
        providerId: workspaceFoundings.providerId,
        status: workspaceFoundings.status,
      })
      .from(workspaceFoundings)
      .where(
        and(
          slug === undefined ? undefined : eq(workspaceFoundings.slug, slug),
          inArray(workspaceFoundings.status, [
            'awaiting_founder',
            'authenticating_founder',
            'founder_authenticated',
            'pending',
            'approved',
            'failed',
          ]),
          lt(workspaceFoundings.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .for('update');
    const candidateProviderIds = candidates
      .map((row) => row.providerId)
      .filter((id): id is string => id !== null);
    const provisionalProviders =
      candidateProviderIds.length === 0
        ? []
        : await tx
            .select({ id: identityProviders.id })
            .from(identityProviders)
            .where(
              and(
                inArray(identityProviders.id, candidateProviderIds),
                eq(identityProviders.status, 'provisional'),
              ),
            )
            .for('update');
    const provisionalIds = new Set(provisionalProviders.map((row) => row.id));
    const expired = candidates.filter(
      (row) =>
        (row.status === 'awaiting_founder' && row.providerId === null) ||
        (row.providerId !== null && provisionalIds.has(row.providerId)),
    );
    if (expired.length === 0) return 0;
    await tx
      .update(workspaceFoundings)
      .set({ status: 'expired', providerId: null, updatedAt: sql`clock_timestamp()` })
      .where(
        inArray(
          workspaceFoundings.id,
          expired.map((row) => row.id),
        ),
      );
    const providerIds = expired
      .map((row) => row.providerId)
      .filter((id): id is string => id !== null && provisionalIds.has(id));
    await tx
      .delete(platformSecrets)
      .where(
        inArray(platformSecrets.name, [
          ...expired.map((row) => `setup-editor:${row.id}`),
          ...providerIds.map((id) => `oidc-client:${id}`),
        ]),
      );
    if (providerIds.length > 0) {
      await tx
        .update(jobs)
        .set({ status: 'done', updatedAt: sql`clock_timestamp()` })
        .where(
          and(
            or(
              inArray(jobs.idempotencyKey, providerIds),
              inArray(sql<string>`${jobs.payload}->>'providerId'`, providerIds),
            ),
            inArray(jobs.status, ['queued', 'processing']),
          ),
        );
      await tx
        .delete(identityProviders)
        .where(
          and(
            inArray(identityProviders.id, providerIds),
            eq(identityProviders.status, 'provisional'),
          ),
        );
    }
    return expired.length;
  });
}

/**
 * Recreates commands whose provisioning record has had no worker lease for five minutes.
 *
 * @param db - Control-plane database connection.
 * @param insertJobTx - Transactional writer for the replacement command.
 * @param olderThanMs - Minimum age before an unleased workflow is stale.
 */
export async function requeueStaleFoundings(
  db: Db,
  insertJobTx: InsertFoundingJobTx,
  olderThanMs = 300_000,
): Promise<string[]> {
  const candidates = await db
    .select({ id: workspaceFoundings.id })
    .from(workspaceFoundings)
    .where(
      and(
        eq(workspaceFoundings.status, 'provisioning'),
        lt(
          workspaceFoundings.updatedAt,
          sql`clock_timestamp() - ${olderThanMs} * interval '1 millisecond'`,
        ),
        notExists(
          db
            .select({ id: jobs.id })
            .from(jobs)
            .where(
              and(
                eq(jobs.type, 'founding.provision'),
                sql`${jobs.idempotencyKey} = ${workspaceFoundings.id}::text`,
                inArray(jobs.status, ['queued', 'processing']),
              ),
            ),
        ),
      ),
    )
    .orderBy(workspaceFoundings.updatedAt, workspaceFoundings.id)
    .limit(100);

  const jobIds: string[] = [];
  for (const candidate of candidates) {
    const job = await db.transaction(async (tx) => {
      const locked = await tx
        .select({ id: workspaceFoundings.id })
        .from(workspaceFoundings)
        .where(
          and(
            eq(workspaceFoundings.id, candidate.id),
            eq(workspaceFoundings.status, 'provisioning'),
            lt(
              workspaceFoundings.updatedAt,
              sql`clock_timestamp() - ${olderThanMs} * interval '1 millisecond'`,
            ),
          ),
        )
        .limit(1)
        .for('update');
      return locked[0] ? insertJobTx(tx, candidate.id) : null;
    });
    if (job?.created) jobIds.push(job.jobId);
  }
  return jobIds;
}
