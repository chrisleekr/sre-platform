import {
  alertEpisodeIntakes,
  upsertAlertEpisodeIntake,
  withTenant,
  type AlertEpisodeIntakeInput,
  type Db,
} from '@sre/db';
import { and, eq } from 'drizzle-orm';
import { assertAlertConnectorGeneration } from './generation';

/** Retains a native cycle without materializing a trigger that contradicts its audited binding.
 * @param db - Tenant-scoped persistence.
 * @param connector - Authenticated connector generation and audited bindings.
 * @param observed - Sanitized provider observation, cycle identity, and whether it repeats a trigger.
 * @returns The retained intake, or null for a repeat notice with no retained or bound cycle.
 */
export async function retainProviderEpisode(
  db: Db,
  connector: { id: string; tenantId: string; settings: unknown; lifecycleVersion?: number },
  observed: AlertEpisodeIntakeInput & { repeatedTrigger?: boolean },
) {
  const { repeatedTrigger, ...retained } = observed;
  const bindings =
    (
      connector.settings as {
        lifecycleBindings?: Array<{
          nativeEpisodeKey?: string;
          nativeMonitorIdentity?: string;
          startsAt: string;
        }>;
      } | null
    )?.lifecycleBindings ?? [];
  const association = bindings.find(
    (binding) => binding.nativeEpisodeKey && binding.nativeEpisodeKey === retained.opaqueEpisodeKey,
  );
  return withTenant(db, connector.tenantId, async (tx) => {
    await assertAlertConnectorGeneration(tx, connector);
    if (repeatedTrigger) {
      const [existing] = retained.opaqueEpisodeKey
        ? await tx
            .select()
            .from(alertEpisodeIntakes)
            .where(
              and(
                eq(alertEpisodeIntakes.tenantId, connector.tenantId),
                eq(alertEpisodeIntakes.dataSourceId, retained.dataSourceId),
                eq(alertEpisodeIntakes.opaqueEpisodeKey, retained.opaqueEpisodeKey),
              ),
            )
            .limit(1)
        : [];
      // A repeat proves the cycle still fires, never when it began, so it opens nothing itself.
      if (!existing && !association) return null;
      // A quarantined start waits for a corrected trigger; a repeat adds no start evidence.
      if (existing?.failureCategory === 'binding_episode_mismatch') return existing;
    }
    // A repeat supplies no start of its own: the audited bound start, or the retained one.
    const input = repeatedTrigger
      ? { ...retained, startsAt: association ? new Date(association.startsAt) : null }
      : retained;
    const mismatch =
      association && input.startsAt && input.startsAt.toISOString() !== association.startsAt;
    const intake = await upsertAlertEpisodeIntake(tx, connector.tenantId, {
      ...input,
      // A quarantined trigger has no accepted episode start; a corrected authenticated replay can fill it.
      startsAt: mismatch ? null : input.startsAt,
      observation: mismatch
        ? {
            ...input.observation,
            annotations: {
              ...input.observation.annotations,
              conflicting_starts_at: input.startsAt!.toISOString(),
            },
          }
        : input.observation,
    });
    const associationRequired =
      !association &&
      intake.startsAt &&
      bindings.some(
        (binding) =>
          !binding.nativeEpisodeKey &&
          binding.nativeMonitorIdentity === intake.observation.monitorIdentity &&
          binding.startsAt === intake.startsAt!.toISOString(),
      );
    if (intake.failureCategory === 'conflicting_episode_times') return intake;
    if (
      mismatch ||
      associationRequired ||
      ['binding_episode_mismatch', 'native_cycle_association_required'].includes(
        intake.failureCategory ?? '',
      )
    ) {
      const failureCategory =
        mismatch ||
        (association &&
          (!intake.startsAt || intake.startsAt.toISOString() !== association.startsAt))
          ? 'binding_episode_mismatch'
          : associationRequired && intake.state !== 'accepted'
            ? 'native_cycle_association_required'
            : null;
      const [updated] = await tx
        .update(alertEpisodeIntakes)
        .set({ failureCategory })
        .where(eq(alertEpisodeIntakes.id, intake.id))
        .returning();
      return updated!;
    }
    return intake;
  });
}
