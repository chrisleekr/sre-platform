import {
  isSurfaceInboundSuperseded,
  recordSurfaceInboundClassificationOutcome,
  withSurfaceInboundRoutingFence,
  type Db,
} from '@sre/db';
import type { ClassifyHandlerDeps, ClassifyOutcome } from './contracts';

type IntakeStateDeps = Pick<
  ClassifyHandlerDeps,
  'isIntakeSuperseded' | 'withIntakeRoutingFence' | 'onOutcome'
>;

function logOutcome(outcome: ClassifyOutcome): void {
  const level = outcome.outcome === 'retry' || outcome.outcome === 'fail_open' ? 'warn' : 'info';
  const line = JSON.stringify({
    level,
    app: 'triage-worker',
    msg: 'Slack inbound classification outcome',
    ...outcome,
  });
  if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Binds the classify consumer to durable inbound receipt ordering and outcome persistence.
 *
 * @param db - System database connection containing queue jobs and inbound receipts.
 * @param coordinationDb - Dedicated connection pool used only for stable-message fences.
 */
export function makeSlackIntakeStateDeps(db: Db, coordinationDb: Db): IntakeStateDeps {
  return {
    isIntakeSuperseded: isSurfaceInboundSuperseded.bind(null, db),
    withIntakeRoutingFence: (tenantId, intakeId, eventAt, eventVersion, identity, fn) =>
      withSurfaceInboundRoutingFence(
        coordinationDb,
        { tenantId, intakeId, eventAt, eventVersion, ...identity },
        fn,
      ),
    onOutcome: async (outcome) => {
      logOutcome(outcome);
      if (!outcome.intakeId) return;
      await recordSurfaceInboundClassificationOutcome(
        db,
        outcome.tenantId,
        outcome.intakeId,
        outcome.outcome,
        outcome.reason,
      );
    },
  };
}
