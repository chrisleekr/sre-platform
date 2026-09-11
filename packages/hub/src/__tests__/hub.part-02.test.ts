import { describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import {
  applySignalObservation,
  createIncident,
  getIncident,
  incidentSignals,
  incidents,
  jobs,
  serializeSignalFence,
  withTenant,
} from '@sre/db';

import { channel, ConversationHub, type HubMessage } from '../hub';
import { createFixture } from './hub.fixture';
const __fixture = createFixture();

describe('ConversationHub', () => {
  // A committed retry republishes; message-ID deduplication makes repeated delivery harmless.
  test('a REDELIVERED appendOnce (inserted:false) still publishes the live event', async () => {
    const origin = `slack:C-hub:${randomUUID()}`;
    const msg = {
      author: 'human' as const,
      kind: 'text' as const,
      content: 'the redelivered reply',
      originSurface: 'slack',
      originMessageId: origin,
    };
    const first = await __fixture.hub.appendOnce(__fixture.tenantA, __fixture.incidentId, msg);

    // Subscribe only AFTER the row exists, so the ONLY publish this can observe is the redelivery's.
    let resolveMsg!: (m: HubMessage) => void;
    const got = new Promise<HubMessage>((r) => {
      resolveMsg = r;
    });
    const unsubscribe = await __fixture.hub.subscribe(__fixture.incidentId, (m) => resolveMsg(m));

    const again = await __fixture.hub.appendOnce(__fixture.tenantA, __fixture.incidentId, msg);
    expect(again.inserted).toBe(false);

    const delivered = await got;
    expect(delivered.id).toBe(first.message.id);
    expect(delivered.content).toBe('the redelivered reply');
    await unsubscribe();
  });

  test('a post-commit delivery failure does not reject durable hub mutations', async () => {
    const unavailable = new Error('Valkey unavailable');
    const publishRedis = {
      publish: vi.fn(async () => {
        throw unavailable;
      }),
    } as unknown as Redis;
    const hub = new ConversationHub(__fixture.app.db, __fixture.redis, publishRedis);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    let result: Awaited<ReturnType<typeof hub.appendOnce>>;
    try {
      result = await hub.appendOnce(__fixture.tenantA, __fixture.incidentId, {
        author: 'human',
        authorUserId: __fixture.memberUserId,
        kind: 'text',
        content: 'durable despite unavailable live delivery',
        originSurface: 'slack',
        originMessageId: `slack:C-hub:${randomUUID()}`,
      });
    } finally {
      warn.mockRestore();
    }

    expect(result.inserted).toBe(true);
    expect(publishRedis.publish).toHaveBeenCalledTimes(1);
    await expect(
      __fixture.hub.appendedByOrigin(
        __fixture.tenantA,
        __fixture.incidentId,
        result.message.originMessageId!,
      ),
    ).resolves.toMatchObject({ id: result.message.id });

    const lifecycleIncident = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `post-commit-lifecycle-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    await expect(
      hub.transitionIncident(__fixture.tenantA, lifecycleIncident.id, {
        to: 'mitigated',
        reason: 'Mitigation was verified.',
        transitionKey: `dashboard:${randomUUID()}`,
        author: 'human',
        authorUserId: __fixture.memberUserId,
        expectedVersion: 0,
      }),
    ).resolves.toMatchObject({ transition: { outcome: 'applied', to: 'mitigated' } });
    await expect(
      getIncident(__fixture.app.db, __fixture.tenantA, lifecycleIncident.id),
    ).resolves.toMatchObject({ status: 'mitigated' });
    expect(publishRedis.publish).toHaveBeenCalledTimes(2);

    const recoveryIncident = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `post-commit-recovery-${randomUUID()}`,
      alertSource: 'alertmanager',
      service: 'checkout',
      severity: 'sev2',
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
      incidentId: recoveryIncident.id,
      surface: 'slack',
      channel: 'C-post-commit-recovery',
      externalMessageId: `resolved-${randomUUID()}`,
      state: 'resolved',
      summary: 'Checkout alert cleared.',
      contentHash: randomUUID(),
      eventKey: `resolved:${randomUUID()}`,
      eventAt: new Date(),
    });
    await expect(
      hub.finalizeRecovery(__fixture.tenantA, recoveryIncident.id, {
        expectedLifecycleVersion: 0,
        expectedSignalFence: serializeSignalFence([cleared.signal]),
        restoreInvestigationStatus: 'assessed',
        verificationStartedAt: new Date(),
        eventKey: `recovery:${randomUUID()}`,
        content: 'Recovery needs responder confirmation.',
        summary: 'Recovery remains unverified.',
        outcome: 'needs_human',
        attempt: 1,
        maxChecks: 3,
        recoveryEvidenceIds: [],
        recoveryUnknowns: ['Whether checkout is stable.'],
        recoveryNextStep: 'Confirm checkout health.',
        recoveryChecks: [],
        assessedMaterials: [],
      }),
    ).resolves.toMatchObject({ applied: true, retryable: false });
    await expect(
      getIncident(__fixture.app.db, __fixture.tenantA, recoveryIncident.id),
    ).resolves.toMatchObject({ recoveryState: 'not_verified' });
    expect(publishRedis.publish).toHaveBeenCalledTimes(3);
  });

  test('subscriptions stay on the persistent handle while publishing uses the bounded handle', async () => {
    const publicationRedis = {
      publish: vi.fn(async () => 1),
      xadd: vi.fn(async () => '1-0'),
      duplicate: vi.fn(() => {
        throw new Error('publication Redis must not own subscriptions');
      }),
    } as unknown as Redis;
    const primaryDuplicate = vi.spyOn(__fixture.redis, 'duplicate');
    const primaryPublish = vi.spyOn(__fixture.redis, 'publish');
    const hub = new ConversationHub(__fixture.app.db, __fixture.redis, publicationRedis);
    let resolveMessage!: (message: HubMessage) => void;
    const delivered = new Promise<HubMessage>((resolve) => {
      resolveMessage = resolve;
    });
    const unsubscribe = await hub.subscribe(__fixture.incidentId, resolveMessage);

    try {
      const message: HubMessage = {
        id: randomUUID(),
        incidentId: __fixture.incidentId,
        author: 'system',
        kind: 'status',
        content: 'subscription probe',
        createdAt: new Date().toISOString(),
      };
      await __fixture.redis.publish(channel(__fixture.incidentId), JSON.stringify(message));
      await expect(delivered).resolves.toMatchObject({ content: 'subscription probe' });
      expect(primaryDuplicate).toHaveBeenCalledTimes(1);
      expect(publicationRedis.duplicate).not.toHaveBeenCalled();
      primaryPublish.mockClear();

      await hub.appendOnce(__fixture.tenantA, __fixture.incidentId, {
        author: 'human',
        authorUserId: __fixture.memberUserId,
        kind: 'text',
        content: 'publication probe',
        originSurface: 'slack',
        originMessageId: `slack:C-hub:${randomUUID()}`,
      });
      expect(publicationRedis.publish).toHaveBeenCalledTimes(1);
      expect(publicationRedis.xadd).toHaveBeenCalledTimes(1);
      expect(primaryPublish).not.toHaveBeenCalled();
    } finally {
      await unsubscribe();
      primaryDuplicate.mockRestore();
      primaryPublish.mockRestore();
    }
  });

  test('lifecycle transitions are validated, version-fenced, and audited exactly once', async () => {
    const id = (
      await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: `lifecycle-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    const requestKey = `dashboard:${randomUUID()}`;

    const mitigated = await __fixture.hub.transitionIncident(__fixture.tenantA, id, {
      to: 'mitigated',
      reason: 'Traffic shifted away from the failing pool.',
      transitionKey: requestKey,
      author: 'human',
      originSurface: 'dashboard',
      authorUserId: __fixture.memberUserId,
      expectedVersion: 0,
    });
    expect(mitigated.transition).toMatchObject({
      outcome: 'applied',
      from: 'open',
      to: 'mitigated',
      version: 1,
    });
    expect(mitigated.message).toMatchObject({
      kind: 'lifecycle',
      lifecycleFrom: 'open',
      lifecycleTo: 'mitigated',
      lifecycleVersion: 1,
      transitionKey: requestKey,
    });

    const duplicate = await __fixture.hub.transitionIncident(__fixture.tenantA, id, {
      to: 'mitigated',
      reason: 'A retry must not add another audit line.',
      transitionKey: requestKey,
      author: 'human',
      authorUserId: __fixture.memberUserId,
      expectedVersion: 0,
    });
    expect(duplicate.transition.outcome).toBe('noop');
    expect(duplicate.message?.id).toBe(mitigated.message?.id);

    const stale = await __fixture.hub.transitionIncident(__fixture.tenantA, id, {
      to: 'resolved',
      reason: 'This command used an old screen version.',
      transitionKey: `dashboard:${randomUUID()}`,
      author: 'human',
      authorUserId: __fixture.memberUserId,
      expectedVersion: 0,
    });
    expect(stale.transition).toMatchObject({ outcome: 'stale', version: 1 });
    expect(stale.message).toBeNull();

    const resolved = await __fixture.hub.transitionIncident(__fixture.tenantA, id, {
      to: 'resolved',
      reason: 'Recovery was verified.',
      transitionKey: `dashboard:${randomUUID()}`,
      author: 'human',
      authorUserId: __fixture.memberUserId,
      expectedVersion: 1,
    });
    expect(resolved.transition).toMatchObject({ outcome: 'applied', version: 2 });

    const invalid = await __fixture.hub.transitionIncident(__fixture.tenantA, id, {
      to: 'mitigated',
      reason: 'Lifecycle cannot move backwards implicitly.',
      transitionKey: `dashboard:${randomUUID()}`,
      author: 'human',
      authorUserId: __fixture.memberUserId,
      expectedVersion: 2,
    });
    expect(invalid.transition.outcome).toBe('invalid');

    const audit = (await __fixture.hub.history(__fixture.tenantA, id)).filter(
      (message) => message.kind === 'lifecycle',
    );
    expect(audit).toHaveLength(2);
    expect(audit.map((message) => message.lifecycleVersion)).toEqual([1, 2]);
  });

  test('a terminal incident cannot reopen from a stale firing-signal snapshot', async () => {
    const id = (
      await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: `signal-fenced-reopen-${randomUUID()}`,
        alertSource: 'alertmanager',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    const externalMessageId = `signal-fenced-reopen-${randomUUID()}`;
    const firing = await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
      incidentId: id,
      surface: 'alertmanager',
      channel: 'prometheus-a',
      externalMessageId,
      state: 'firing',
      summary: 'Checkout errors are firing.',
      contentHash: 'firing',
      eventKey: `${externalMessageId}:firing`,
      eventAt: new Date('2026-08-31T01:00:00.000Z'),
    });
    await __fixture.hub.transitionIncident(__fixture.tenantA, id, {
      to: 'resolved',
      reason: 'A responder resolved the incident.',
      transitionKey: `resolved:${id}`,
      author: 'human',
      authorUserId: __fixture.memberUserId,
      expectedVersion: 0,
    });
    await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
      incidentId: id,
      surface: 'alertmanager',
      channel: 'prometheus-a',
      externalMessageId,
      state: 'resolved',
      summary: 'Checkout errors cleared.',
      contentHash: 'resolved',
      eventKey: `${externalMessageId}:resolved`,
      eventAt: new Date('2026-08-31T01:01:00.000Z'),
    });

    const reopened = await __fixture.hub.transitionIncident(__fixture.tenantA, id, {
      to: 'open',
      reason: 'The stale signal appeared to fire again.',
      transitionKey: `stale-reopen:${id}`,
      author: 'system',
      expectedVersion: 1,
      expectedSignals: [{ id: firing.signal.id, version: firing.signal.version, state: 'firing' }],
    });

    expect(reopened).toMatchObject({
      transition: { outcome: 'precondition_failed' },
      message: null,
    });
    expect(await getIncident(__fixture.app.db, __fixture.tenantA, id)).toMatchObject({
      status: 'resolved',
      lifecycleVersion: 1,
    });
  });

  test('one transition key cannot apply two concurrent lifecycle targets', async () => {
    const id = (
      await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: `lifecycle-key-race-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
    const transitionKey = `dashboard:${id}:${randomUUID()}`;
    let rowLocked!: () => void;
    const locked = new Promise<void>((resolve) => (rowLocked = resolve));
    let releaseRow!: () => void;
    const release = new Promise<void>((resolve) => (releaseRow = resolve));
    const blocker = __fixture.admin.db.transaction(async (tx) => {
      await tx.execute(sql`select id from incidents where id = ${id} for update`);
      rowLocked();
      await release;
    });
    await locked;

    const first = __fixture.hub.transitionIncident(__fixture.tenantA, id, {
      to: 'mitigated',
      reason: 'First concurrent target.',
      transitionKey,
      author: 'human',
      authorUserId: __fixture.memberUserId,
    });
    const second = __fixture.hub.transitionIncident(__fixture.tenantA, id, {
      to: 'resolved',
      reason: 'Second concurrent target using the same request key.',
      transitionKey,
      author: 'human',
      authorUserId: __fixture.memberUserId,
    });
    // Hold the incident row long enough for both requests to reach their serialization fence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseRow();
    await blocker;
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.transition.outcome).sort()).toEqual(['applied', 'noop']);
    expect(await getIncident(__fixture.app.db, __fixture.tenantA, id)).toMatchObject({
      lifecycleVersion: 1,
    });
    const audit = (await __fixture.hub.history(__fixture.tenantA, id)).filter(
      (message) => message.transitionKey === transitionKey,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.lifecycleVersion).toBe(1);
  });

  test('a terminal occurrence cannot reopen beside an active sibling with the same fingerprint', async () => {
    const fingerprint = `reopen-${randomUUID()}`;
    const first = (
      await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint,
        alertSource: 'slack',
        service: 'api',
        severity: 'sev2',
      })
    ).id;
    await __fixture.hub.transitionIncident(__fixture.tenantA, first, {
      to: 'resolved',
      reason: 'Recovery was verified.',
      transitionKey: `recovery:${randomUUID()}`,
      author: 'agent',
      expectedVersion: 0,
    });
    await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint,
      alertSource: 'slack',
      service: 'api',
      severity: 'sev2',
    });

    const reopen = await __fixture.hub.transitionIncident(__fixture.tenantA, first, {
      to: 'open',
      reason: 'Old occurrence fired again.',
      transitionKey: `signal:${randomUUID()}`,
      author: 'system',
      expectedVersion: 1,
    });
    expect(reopen.transition.outcome).toBe('active_sibling');
    expect(reopen.message).toBeNull();
  });

  test('an idle lifecycle transition rechecks recent conversation activity under the row fence', async () => {
    const id = (
      await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: `idle-race-${randomUUID()}`,
        alertSource: 'slack',
        service: 'worker',
        severity: 'sev3',
      })
    ).id;
    await __fixture.admin.db
      .update(incidents)
      .set({ updatedAt: sql`now() - interval '2 days'` })
      .where(sql`id = ${id}`);
    await __fixture.hub.append(__fixture.tenantA, id, {
      author: 'human',
      authorUserId: __fixture.memberUserId,
      content: 'Current responder activity must defeat the stale sweep snapshot.',
    });

    const result = await __fixture.hub.transitionIncident(__fixture.tenantA, id, {
      to: 'closed',
      reason: 'Automatically closed after inactivity.',
      transitionKey: `idle-close:${id}:0`,
      author: 'system',
      expectedVersion: 0,
      idleBefore: new Date(Date.now() - 24 * 60 * 60 * 1_000),
    });
    expect(result.transition.outcome).toBe('precondition_failed');
    expect(result.message).toBeNull();
  });

  test('one resolution event cannot mutate a second signal on redelivery', async () => {
    const createSignal = async (suffix: string) => {
      const incident = await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: `resolution-claim-${suffix}-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      });
      const opened = await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
        incidentId: incident.id,
        surface: 'slack',
        channel: 'C-resolution-claim',
        externalMessageId: `root-${suffix}`,
        state: 'firing',
        summary: 'CheckoutHighErrorRate',
        contentHash: `firing-${suffix}`,
        eventKey: `firing-${suffix}`,
        eventAt: new Date('2026-08-21T02:00:00.000Z'),
      });
      return { incident, signal: opened.signal };
    };
    const first = await createSignal('a');
    const second = await createSignal('b');
    const eventKey = `slack:C-resolution-claim:resolved:${randomUUID()}`;
    const resolve = (incidentId: string, signalId: string) =>
      withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        __fixture.hub.observeSignalTx(
          tx,
          __fixture.tenantA,
          {
            incidentId,
            surface: 'slack',
            channel: 'C-resolution-claim',
            externalMessageId: signalId === first.signal.id ? 'root-a' : 'root-b',
            state: 'resolved',
            summary: 'CheckoutHighErrorRate resolved',
            contentHash: 'resolved',
            eventKey,
            eventAt: new Date('2026-08-21T02:01:00.000Z'),
          },
          'CheckoutHighErrorRate resolved',
        ),
      );

    const applied = await resolve(first.incident.id, first.signal.id);
    const replayedAgainstAnotherTarget = await resolve(second.incident.id, second.signal.id);

    expect(applied.observation.applied).toBe(true);
    expect(replayedAgainstAnotherTarget.observation).toMatchObject({
      applied: false,
      signal: { id: first.signal.id, state: 'resolved' },
    });
    const rows = await __fixture.admin.db
      .select({ id: incidentSignals.id, state: incidentSignals.state })
      .from(incidentSignals)
      .where(sql`id in (${first.signal.id}, ${second.signal.id})`);
    expect(rows.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [
        { id: first.signal.id, state: 'resolved' },
        { id: second.signal.id, state: 'firing' },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  test('recovery cannot retarget across a terminal lifecycle followed by reopen', async () => {
    const incident = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: `recovery-terminal-race-${randomUUID()}`,
      alertSource: 'alertmanager',
      service: 'checkout',
      severity: 'sev2',
    });
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
      incidentId: incident.id,
      provider: 'alertmanager',
      providerFingerprint: `checkout-${randomUUID()}`,
      surface: 'slack',
      channel: 'C-alerts',
      externalMessageId: `resolved-${randomUUID()}`,
      state: 'resolved',
      summary: 'Checkout recovered.',
      contentHash: randomUUID(),
      materialHash: randomUUID(),
      eventKey: `resolved:${randomUUID()}`,
      eventAt: new Date(),
    });
    const jobId = randomUUID();
    await __fixture.admin.db.insert(jobs).values({
      id: jobId,
      tenantId: __fixture.tenantA,
      type: 'recovery.verify',
      payload: {
        incidentId: incident.id,
        lifecycleVersion: 0,
        signalFence: serializeSignalFence([cleared.signal]),
      },
      status: 'processing',
      stream: 'hub-recovery-test',
    });
    await __fixture.hub.transitionIncident(__fixture.tenantA, incident.id, {
      to: 'resolved',
      reason: 'Provider reported recovery.',
      transitionKey: `resolved:${incident.id}`,
      author: 'system',
      expectedVersion: 0,
    });
    await __fixture.hub.transitionIncident(__fixture.tenantA, incident.id, {
      to: 'open',
      reason: 'Responder reopened the incident.',
      transitionKey: `reopened:${incident.id}`,
      author: 'human',
      authorUserId: __fixture.memberUserId,
      expectedVersion: 1,
    });

    const result = await __fixture.hub.finalizeRecovery(__fixture.tenantA, incident.id, {
      expectedLifecycleVersion: 0,
      expectedSignalFence: serializeSignalFence([cleared.signal]),
      recoveryJobId: jobId,
      restoreInvestigationStatus: 'assessed',
      verificationStartedAt: new Date(),
      eventKey: `recovery:${jobId}`,
      content: 'Recovery verified.',
      summary: 'Checkout recovered.',
      outcome: 'recovered',
      attempt: 1,
      maxChecks: 3,
      recoveryEvidenceIds: [],
      recoveryUnknowns: [],
      recoveryNextStep: null,
      recoveryChecks: [],
      assessedMaterials: [],
    });

    expect(result).toMatchObject({ applied: false, retryable: false });
    const row = (
      await __fixture.admin.db
        .select({ payload: jobs.payload })
        .from(jobs)
        .where(eq(jobs.id, jobId))
    )[0];
    expect(row?.payload).toMatchObject({ lifecycleVersion: 0 });
  });
});
