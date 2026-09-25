import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createIncident, getIncident, type Tx } from '@sre/db';
import { createFixture } from './hub.fixture';

const hooks = vi.hoisted(() => ({
  afterFence: undefined as ((tx: Tx) => Promise<void>) | undefined,
  beforeGroup: undefined as ((tx: Tx) => Promise<void>) | undefined,
}));
vi.mock('@sre/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sre/db')>();
  return {
    ...actual,
    async humanMessageFenceMatchesTx(
      ...args: Parameters<typeof actual.humanMessageFenceMatchesTx>
    ) {
      const matches = await actual.humanMessageFenceMatchesTx(...args);
      await hooks.afterFence?.(args[0]);
      return matches;
    },
    async lockResponseGroupWorkTx(...args: Parameters<typeof actual.lockResponseGroupWorkTx>) {
      await hooks.beforeGroup?.(args[0]);
      return actual.lockResponseGroupWorkTx(...args);
    },
  };
});
const fixture = createFixture();
function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}
async function backendPid(tx: Tx): Promise<number> {
  const result = await tx.execute(sql`select pg_backend_pid()::int as pid`);
  return Number((result as unknown as Array<{ pid: number }>)[0]!.pid);
}

test('a fenced verbal lifecycle change and dashboard policy change share graph-before-row lock order', async () => {
  const incident = await createIncident(fixture.app.db, fixture.tenantA, {
    fingerprint: randomUUID(),
    alertSource: 'manual',
    service: 'checkout',
    severity: 'sev3',
  });
  const request = await fixture.hub.append(fixture.tenantA, incident.id, {
    author: 'human',
    authorUserId: fixture.memberUserId,
    kind: 'text',
    content: 'Mitigation is in place.',
  });
  const fenceHeld = barrier();
  const releaseFence = barrier();
  const policyEntered = barrier();
  let lifecyclePid = 0;
  let policyPid = 0;
  let startingPolicy = false;
  hooks.afterFence = async (tx) => {
    lifecyclePid = await backendPid(tx);
    fenceHeld.release();
    await releaseFence.reached;
  };
  hooks.beforeGroup = async (tx) => {
    if (!startingPolicy) return;
    policyPid = await backendPid(tx);
    policyEntered.release();
  };
  const lifecycle = fixture.hub.transitionIncident(fixture.tenantA, incident.id, {
    to: 'mitigated',
    reason: 'The responder confirmed mitigation.',
    transitionKey: randomUUID(),
    author: 'agent',
    expectedVersion: 0,
    humanMessageFence: request.id,
  });
  await fenceHeld.reached;
  startingPolicy = true;
  const policy = fixture.hub.changeResolutionPolicy(fixture.tenantA, incident.id, {
    policy: 'provider_clear',
    reason: 'The monitor is the agreed recovery criterion.',
    requestId: randomUUID(),
    expectedVersion: 0,
    authorUserId: fixture.memberUserId,
    enqueueRecoveryTx: async () => null,
  });
  let waitFailure: unknown;
  let waitingLockTypes: string[] = [];
  try {
    await policyEntered.reached;
    await expect
      .poll(async () => {
        const [row] = await fixture.admin.sql<Array<{ blockers: number[] }>>`
        select pg_blocking_pids(${policyPid}) as blockers
      `;
        return row?.blockers ?? [];
      })
      .toContain(lifecyclePid);
    const waits = await fixture.admin.sql<Array<{ locktype: string }>>`
      select locktype from pg_locks where pid = ${policyPid} and not granted
    `;
    waitingLockTypes = waits.map((row) => row.locktype);
  } catch (error) {
    waitFailure = error;
  } finally {
    releaseFence.release();
  }
  const settled = await Promise.allSettled([lifecycle, policy]);
  hooks.afterFence = undefined;
  hooks.beforeGroup = undefined;
  if (waitFailure) throw waitFailure;
  const outcomes = settled.map((result) => {
    if (result.status === 'rejected')
      return { errorCode: result.reason.cause?.code ?? result.reason.code };
    return 'transition' in result.value ? result.value.transition.outcome : result.value.outcome;
  });
  expect({ waitingLockTypes, outcomes }).toEqual({
    waitingLockTypes: ['advisory'],
    outcomes: ['applied', 'stale'],
  });
  expect(await getIncident(fixture.app.db, fixture.tenantA, incident.id)).toMatchObject({
    status: 'mitigated',
    resolutionPolicy: 'verified_recovery',
    lifecycleVersion: 1,
  });
}, 20_000);
