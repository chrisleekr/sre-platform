import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Redis } from 'ioredis';

import {
  createIncident,
  getIncident,
  incidentMessages,
  incidentSignals,
  incidents,
  jobs,
  recordSurfaceBinding,
  surfaceBindings,
} from '@sre/db';

import { Queue } from '@sre/queue';

import {
  ThreadAlreadyBoundError,
  routeToIncident,
  type IncidentSignal,
} from '../route-to-incident';

import { createFixture } from './route-to-incident.fixture';

const __fixture = createFixture();

describe('routeToIncident', () => {
  // --- incident + binding + triage job are ONE atomic unit ------------------------------------
  // All three, or none. A binding written best-effort AFTER the incident could be lost to a crash between
  // the two, leaving an incident with no thread to speak in. So could the JOB: enqueue used to XADD from
  // a separate autocommit connection, so a crash between the commit and the enqueue left a live incident
  // with a live thread and nothing queued to investigate it — and reconcile() only re-dispatches rows that
  // already exist in `jobs`, so there was nothing to heal. The job row now rides the same transaction
  // (transactional outbox); only the XADD is post-commit, and reconcile() covers that gap.

  const bindingsFor = (externalId: string) =>
    __fixture.admin.db
      .select()
      .from(surfaceBindings)
      .where(sql`tenant_id = ${__fixture.tenantId} and external_id = ${externalId}`);

  const incidentsFor = (fingerprint: string) =>
    __fixture.admin.db
      .select()
      .from(incidents)
      .where(sql`tenant_id = ${__fixture.tenantId} and fingerprint = ${fingerprint}`);

  const jobsForIncident = (incidentId: string) =>
    __fixture.admin.db
      .select()
      .from(jobs)
      .where(sql`tenant_id = ${__fixture.tenantId} and payload->>'incidentId' = ${incidentId}`);

  // --- the correlation window closes when the incident does ---------------------------------
  // An alert fires, gets triaged, and a responder closes the incident. Later the SAME
  // fingerprint fires again — a NEW Slack message, a NEW thread, a human waiting in it.
  //
  // Alertmanager reaches this generic terminal/new-root invariant through its bounded provider-episode
  // router. These tests isolate the workspace behavior from that adapter decision.
  //
  // The failure these pin, as it stood under the old full unique on (tenant, fingerprint):
  //   1. The incident upsert conflicted on (tenant, fingerprint) with `set: { updatedAt }` ONLY, so it
  //      handed back the CLOSED incident's id; created_at/title/severity/status/occurrence_count all
  // kept occurrence 's values.
  //   2. recordSurfaceBinding(OLD_ID, NEW_thread) conflicted on surface_bindings_incident_uq ->
  //      onConflictDoNothing -> the re-read found no owner for the new thread, fell through to
  //      `forIncident`, warned "binding not moved" and returned the OLD binding.
  //   3. The funnel's `binding.incidentId !== id` guard could not fire: both were OLD_ID.
  //   4. The transaction committed and the old mixed-state writer reopened the closed row.
  // Net effect: the AI investigates in the STALE thread. No drop, no hard failure — silence.

  /** Seed a flapper's occurrence and leave it in a terminal correlation state. */
  const seedClosedFlapper = async (fingerprint: string, channel: string, threadId: string) => {
    const first = await routeToIncident(__fixture.deps(), {
      tenantId: __fixture.tenantId,
      source: 'slack',
      fingerprint,
      service: 'checkout',
      severity: 'sev2',
      title: 'checkout 5xx',
      origin: __fixture.origin(channel, threadId),
    });
    // This test needs the terminal correlation state, not the scheduler and audited transition path.
    await __fixture.setLifecycle(first.incidentId!, 'closed');
    // Occurrence 's triage finished before the responder closed the incident. Marking it done is also
    // what keeps jobs_resume_coalesce_idx (partial on status='queued', keyed by payload->>'incidentId')
    // out of the way: in the RED state the second signal re-uses the OLD incident id, so a still-queued
    // first job would make the job insert 23505 and mask the assertion under test behind a setup error.
    await __fixture.admin.db
      .update(jobs)
      .set({ status: 'done' })
      .where(sql`id = ${first.jobId!}`);
    // Faithful to the real timeline, not a weakening of dedup — and the margin is exactly zero, not
    // "hours", so the ordering argument has to be made properly rather than waved at:
    //   - The Slack path ALWAYS passes INBOUND_DEDUP_TTL_SEC = 86_400 (classify-consumer.ts). Cited by
    //     symbol, not line: this citation has now been stale twice, because a line number across a file
    //     boundary rots on any edit above the target.
    //     DEFAULT_DEDUP_TTL_SEC = 300 is only the no-TTL fallback and never applies to this path.
    //   - That key is (re)set by the LAST signal, at t=S, and expires at S+24h.
    // Alertmanager supplies a distinct per-episode dedup key. This isolated router test uses the default
    // fingerprint key, so deleting it represents the later episode without changing dedup behavior.
    await __fixture.redis.del(`dedup:${__fixture.tenantId}:${fingerprint}`);
    return first;
  };

  test('commits the accepted surface opener with the incident, binding, and triage job', async () => {
    const threadId = `${Date.now()}.0000`;
    const opener = {
      author: 'system' as const,
      content: 'System saturated.\nSeverity: warning',
      originSurface: 'slack' as const,
      originMessageId: `slack:C_OPENER:${threadId}`,
    };
    const routed = await routeToIncident(__fixture.depsWithOpener(), {
      tenantId: __fixture.tenantId,
      source: 'slack',
      fingerprint: `slack:${randomUUID()}`,
      service: 'node-192.168.1.203',
      severity: 'sev3',
      title: 'System saturated',
      origin: __fixture.origin('C_OPENER', threadId),
      opener,
    });

    const rows = await __fixture.admin.db
      .select()
      .from(incidentMessages)
      .where(sql`tenant_id = ${__fixture.tenantId} and incident_id = ${routed.incidentId!}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(opener);
  });

  test('rolls back all incident side effects when an opener has no transactional writer', async () => {
    const fingerprint = `slack:${randomUUID()}`;
    const threadId = `${Date.now()}.00001`;
    await expect(
      routeToIncident(__fixture.deps(), {
        tenantId: __fixture.tenantId,
        source: 'slack',
        fingerprint,
        service: 'node',
        severity: 'sev3',
        origin: __fixture.origin('C_NO_WRITER', threadId),
        opener: {
          author: 'system',
          content: 'must not be separated from the incident',
          originSurface: 'slack',
          originMessageId: `slack:C_NO_WRITER:${threadId}`,
        },
      }),
    ).rejects.toThrow('incident opener writer not configured');

    expect(await __fixture.redis.get(`dedup:${__fixture.tenantId}:${fingerprint}`)).toBeNull();
    expect(
      await __fixture.admin.db
        .select()
        .from(incidents)
        .where(sql`fingerprint = ${fingerprint}`),
    ).toHaveLength(0);
  });

  test('dedup miss: creates the incident and enqueues a triage job carrying the context', async () => {
    const fingerprint = `slo-burn:${randomUUID()}:fast`;
    const context = { sloId: 's1', tier: 'fast', budgetPct: -0.2 };
    const r = await routeToIncident(__fixture.deps(), {
      tenantId: __fixture.tenantId,
      source: 'slo-burn',
      fingerprint,
      service: 'checkout',
      severity: 'sev2',
      context,
      origin: __fixture.origin('C_BURN', `${Date.now()}.0001`),
    });
    expect(r.deduped).toBe(false);
    expect(r.incidentId).toBeTruthy();
    expect(r.jobId).toBeTruthy();

    // The incident carries the free-text source and severity — no connector-enum membership needed.
    const incident = await getIncident(__fixture.app.db, __fixture.tenantId, r.incidentId!);
    expect(incident).toMatchObject({
      fingerprint,
      alertSource: 'slo-burn',
      service: 'checkout',
      severity: 'sev2',
    });

    // The triage job carries the incident id and forwards the burn context opaquely as `alert`.
    const jobRows = await __fixture.admin.db
      .select()
      .from(jobs)
      .where(sql`id = ${r.jobId!}`);
    expect(jobRows[0]).toMatchObject({
      tenantId: __fixture.tenantId,
      type: 'triage',
      status: 'queued',
    });
    const payload = jobRows[0]!.payload as { incidentId: string; alert: typeof context };
    expect(payload.incidentId).toBe(r.incidentId);
    expect(payload.alert).toMatchObject({ sloId: 's1', tier: 'fast' });
  });

  // the classifier title threads through the funnel into the triage job payload so
  // the worker can build the incident-open runbook-seed query. Additive: title is optional on the
  // signal and the payload. RED until routeToIncident forwards signal.title onto the enqueued payload.
  test('C1 threads the classifier title through to the triage job payload', async () => {
    const fingerprint = `slack:${randomUUID()}`;
    const signal: IncidentSignal = {
      tenantId: __fixture.tenantId,
      source: 'slack',
      fingerprint,
      service: 'checkout',
      severity: 'sev2',
      title: 'checkout down',
      origin: __fixture.origin('C_TITLE', `${Date.now()}.0002`),
    };
    const r = await routeToIncident(__fixture.deps(), signal);
    expect(r.deduped).toBe(false);
    expect(r.jobId).toBeTruthy();

    const jobRows = await __fixture.admin.db
      .select()
      .from(jobs)
      .where(sql`id = ${r.jobId!}`);
    const payload = jobRows[0]!.payload as { incidentId: string; title?: string };
    expect(payload.title).toBe('checkout down');
  });

  test('dedup hit: a second signal with the same fingerprint is suppressed (no new job)', async () => {
    const fingerprint = `slo-burn:${randomUUID()}:slow`;
    const signal: IncidentSignal = {
      tenantId: __fixture.tenantId,
      source: 'slo-burn',
      fingerprint,
      service: 'api',
      severity: 'sev3',
      origin: __fixture.origin('C_DEDUP', `${Date.now()}.0003`),
    };
    const first = await routeToIncident(__fixture.deps(), signal);
    expect(first.deduped).toBe(false);
    const second = await routeToIncident(__fixture.deps(), signal);
    expect(second.deduped).toBe(true);
    expect(second.jobId).toBeUndefined();
  });

  test('per-signal dedupTtlSec sets the suppression window (the fast/slow re-alert cadence)', async () => {
    const fingerprint = `slo-burn:${randomUUID()}:fast`;
    await routeToIncident(__fixture.deps(), {
      tenantId: __fixture.tenantId,
      source: 'slo-burn',
      fingerprint,
      service: 'api',
      severity: 'sev2',
      dedupTtlSec: 3_600,
      origin: __fixture.origin('C_TTL', `${Date.now()}.0004`),
    });
    const ttl = await __fixture.redis.ttl(`dedup:${__fixture.tenantId}:${fingerprint}`);
    expect(ttl).toBeGreaterThan(3_500);
    expect(ttl).toBeLessThanOrEqual(3_600);
  });

  // --- suppression keys on the MESSAGE, incident identity on the fingerprint ------------------
  // They are only the same thing when the caller's fingerprint is per-message. The push path's is; the
  // mention path's is thread-derived, so one key used to suppress every message in the thread for 24h.

  test('C4 a signal with no dedupKey keys on its fingerprint', async () => {
    const fingerprint = `slo-burn:${randomUUID()}:default`;
    await routeToIncident(__fixture.deps(), {
      tenantId: __fixture.tenantId,
      source: 'slo-burn',
      fingerprint,
      service: 'api',
      severity: 'sev3',
      dedupTtlSec: 3_600,
      origin: __fixture.origin('C_DEFAULT_KEY', `${Date.now()}.0011`),
    });
    // The push and degraded paths pass no dedupKey and must keep suppressing on the fingerprint alone.
    const ttl = await __fixture.redis.ttl(`dedup:${__fixture.tenantId}:${fingerprint}`);
    expect(ttl).toBeGreaterThan(3_500);
  });

  test('C7 the same fingerprint with a DIFFERENT dedupKey is not deduped', async () => {
    const fingerprint = `slack:${randomUUID()}`;
    const channel = 'C_PER_MSG';
    const threadId = `${Date.now()}.0012`;
    const signal = (dedupKey: string): IncidentSignal => ({
      tenantId: __fixture.tenantId,
      source: 'slack',
      fingerprint,
      service: 'checkout',
      severity: 'sev2',
      dedupTtlSec: 86_400,
      dedupKey,
      origin: __fixture.origin(channel, threadId),
    });

    // Two distinct messages in ONE thread: same fingerprint (thread is the incident), different keys.
    const first = await routeToIncident(__fixture.deps(), signal('slack:C_PER_MSG:0012'));
    expect(first.deduped).toBe(false);
    // Setup, not a weakening: the first triage job is still 'queued', and the second signal re-uses the
    // same incident, so jobs_resume_coalesce_idx (tenant, type, payload->>'incidentId' where queued) would
    // 23505 the second job insert and mask the assertion under test behind a setup error. Same precedent
    // as seedClosedFlapper below.
    await __fixture.admin.db
      .update(jobs)
      .set({ status: 'done' })
      .where(sql`id = ${first.jobId!}`);

    const second = await routeToIncident(__fixture.deps(), signal('slack:C_PER_MSG:0013'));
    expect(second.deduped).toBe(false);
    expect(second.incidentId).toBe(first.incidentId);

    // ...while the FIRST key still suppresses its own redelivery. Both halves matter: dedup that never
    // fires is not dedup.
    const redelivered = await routeToIncident(__fixture.deps(), signal('slack:C_PER_MSG:0012'));
    expect(redelivered.deduped).toBe(true);
  });

  test('a reused incident leaves the new signal for the caller to audit and reassess atomically', async () => {
    const fingerprint = `slack:${randomUUID()}`;
    const channel = 'C_REUSED_SIGNAL';
    const threadId = `${Date.now()}.00121`;
    const routedSignal = (externalMessageId: string): IncidentSignal => ({
      tenantId: __fixture.tenantId,
      source: 'slack',
      fingerprint,
      service: 'checkout',
      severity: 'sev2',
      dedupKey: `slack:${channel}:${externalMessageId}`,
      origin: __fixture.origin(channel, threadId),
      signal: {
        surface: 'slack',
        channel,
        externalMessageId,
        state: 'firing',
        summary: `Checkout alert ${externalMessageId}`,
        contentHash: `hash-${externalMessageId}`,
        eventKey: `slack:${channel}:${externalMessageId}:producer:bot:B_ALERTS`,
        eventAt: new Date(`2026-08-22T10:00:0${externalMessageId === 'first' ? '0' : '1'}.000Z`),
      },
    });

    const first = await routeToIncident(__fixture.deps(), routedSignal('first'));
    const second = await routeToIncident(__fixture.deps(), routedSignal('second'));

    expect(second).toMatchObject({ deduped: false, incidentId: first.incidentId, reused: true });
    expect(second.jobId).toBeUndefined();
    const persisted = await __fixture.admin.db
      .select({ externalMessageId: incidentSignals.externalMessageId })
      .from(incidentSignals)
      .where(sql`tenant_id = ${__fixture.tenantId} and incident_id = ${first.incidentId!}`);
    expect(persisted).toEqual([{ externalMessageId: 'first' }]);
  });

  test('incident, binding and triage job commit together', async () => {
    const fingerprint = `slack:${randomUUID()}`;
    const threadId = `${Date.now()}.000101`;
    const externalId = `C_NEW:${threadId}`;
    const signal: IncidentSignal = {
      tenantId: __fixture.tenantId,
      source: 'slack',
      fingerprint,
      service: 'checkout',
      severity: 'sev2',
      origin: __fixture.origin('C_NEW', threadId),
    };

    const r = await routeToIncident(__fixture.deps(), signal);
    expect(r.deduped).toBe(false);
    expect(r.incidentId).toBeTruthy();

    // The incident exists...
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, r.incidentId!)).toBeTruthy();
    // ...so does the binding that tells the fan-out which thread to speak in...
    const bindings = await bindingsFor(externalId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ incidentId: r.incidentId, surface: 'slack' });
    // ...and so does the durable triage job, dispatched onto the stream after the commit.
    const jobRows = await jobsForIncident(r.incidentId!);
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]).toMatchObject({ id: r.jobId, type: 'triage', status: 'queued' });
    expect(jobRows[0]!.streamId).toBeTruthy(); // publishJob ran and recorded the stream entry
  });

  test('a throw inside the tx leaves NO incident, NO binding and NO job', async () => {
    // A DIFFERENT incident already owns this thread. The binding insert is idempotent (it must not raise,
    // or a redelivery would collide forever) and reports the OWNER, so the funnel rolls its own incident
    // back rather than leaving one that can never be answered — and the job, written on the same tx, goes
    // with it. This is the "throw anywhere in the tx" case: the write is after createIncident.
    const threadId = `${Date.now()}.000202`;
    const { id: squatter } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `squatter-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: squatter,
      surface: 'slack',
      channel: 'C_NEW',
      threadId,
    });

    const fingerprint = `slack:${randomUUID()}`;
    const key = `dedup:${__fixture.tenantId}:${fingerprint}`;
    await expect(
      routeToIncident(__fixture.deps(), {
        tenantId: __fixture.tenantId,
        source: 'slack',
        fingerprint,
        service: 'checkout',
        severity: 'sev2',
        origin: __fixture.origin('C_NEW', threadId),
      }),
    ).rejects.toBeInstanceOf(ThreadAlreadyBoundError);

    // No half-written incident, and no orphaned job for it: the whole tx rolled back.
    expect(await incidentsFor(fingerprint)).toHaveLength(0);
    expect(await bindingsFor(`C_NEW:${threadId}`)).toHaveLength(1); // only the squatter's
    expect(await jobsForIncident(squatter)).toHaveLength(0); // and nothing enqueued against the owner
    // And the dedup reservation is released (ttl -2 = key absent), so a re-alert is not suppressed.
    expect(await __fixture.redis.ttl(key)).toBe(-2);
  });

  test('a taken thread reports the OWNING incident, so the caller can attach instead of retrying', async () => {
    // A retry would collide identically every time and dead-letter the message. The error names the owner
    // so the caller folds the message into the incident that already answers in that thread.
    const threadId = `${Date.now()}.000404`;
    const { id: owner } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `owner-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: owner,
      surface: 'slack',
      channel: 'C_OWNED',
      threadId,
    });

    const err = await routeToIncident(__fixture.deps(), {
      tenantId: __fixture.tenantId,
      source: 'slack',
      fingerprint: `slack:${randomUUID()}`,
      service: 'checkout',
      severity: 'sev2',
      origin: __fixture.origin('C_OWNED', threadId),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ThreadAlreadyBoundError);
    expect((err as ThreadAlreadyBoundError).incidentId).toBe(owner);
  });

  test('redelivery creates neither a second incident nor a duplicate binding', async () => {
    const fingerprint = `slack:${randomUUID()}`;
    const threadId = `${Date.now()}.000303`;
    const externalId = `C_NEW:${threadId}`;
    const signal: IncidentSignal = {
      tenantId: __fixture.tenantId,
      source: 'slack',
      fingerprint,
      service: 'checkout',
      severity: 'sev2',
      origin: __fixture.origin('C_NEW', threadId),
    };

    const first = await routeToIncident(__fixture.deps(), signal);
    // Drop the dedup key so the second call actually re-enters the write path (a dedup hit would make
    // this test vacuous): the durable idempotency, not the Valkey window, is what must hold. The first
    // triage job is marked picked-up so the redelivery is not rejected by the queued-job coalescing
    // index before it ever reaches the incident/binding writes.
    await __fixture.redis.del(`dedup:${__fixture.tenantId}:${fingerprint}`);
    await __fixture.admin.db
      .update(jobs)
      .set({ status: 'processing' })
      .where(sql`id = ${first.jobId!}`);
    const second = await routeToIncident(__fixture.deps(), signal);

    expect(second.incidentId).toBe(first.incidentId); // upsert on (tenant, fingerprint) reuses it
    expect(await incidentsFor(fingerprint)).toHaveLength(1);
    expect(await bindingsFor(externalId)).toHaveLength(1);
  });

  test('a post-commit publish failure RESOLVES: the work is durable, reconcile dispatches it', async () => {
    // publishJob is post-commit dispatch, not part of the write. Rethrowing here used to fail the whole
    // classify handler, which retried — and once the first triage job left `queued` it dropped out of
    // jobs_resume_coalesce_idx (predicate: status = 'queued'), so the retry inserted a SECOND triage job:
    // two LLM investigations narrating into the customer's thread. A Queue whose XADD rejects (its redis
    // has only a failing xadd; insertJobTx never touches redis) drives the exact failure.
    const brokenQueue = new Queue(__fixture.admin.db, {
      xadd: () => Promise.reject(new Error('valkey down')),
    } as unknown as Redis);
    const fingerprint = `slack:${randomUUID()}`;
    const threadId = `${Date.now()}.000505`;
    const signal: IncidentSignal = {
      tenantId: __fixture.tenantId,
      source: 'slack',
      fingerprint,
      service: 'checkout',
      severity: 'sev2',
      origin: __fixture.origin('C_PUBFAIL', threadId),
    };

    const r = await routeToIncident(
      { appDb: __fixture.app.db, redis: __fixture.redis, queue: brokenQueue },
      signal,
    );
    expect(r.deduped).toBe(false);

    // All three writes are durable; the job is `queued` with a null stream_id, which is reconcile()'s
    // to re-dispatch.
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, r.incidentId!)).toBeTruthy();
    expect(await bindingsFor(`C_PUBFAIL:${threadId}`)).toHaveLength(1);
    const jobRows = await jobsForIncident(r.incidentId!);
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]).toMatchObject({ id: r.jobId, status: 'queued' });
    expect(jobRows[0]!.streamId).toBeNull();

    // The dedup reservation is HELD, not released: the work happened, so a re-alert inside the window is
    // still a duplicate.
    expect(await __fixture.redis.ttl(`dedup:${__fixture.tenantId}:${fingerprint}`)).toBeGreaterThan(
      0,
    );

    // And a redelivery mints no second investigation. Claim the job first, so it has left the coalescing
    // index and the durable guard could NOT save us — only the held reservation does.
    await __fixture.admin.db
      .update(jobs)
      .set({ status: 'processing' })
      .where(sql`id = ${r.jobId!}`);
    const second = await routeToIncident(__fixture.deps(), signal);
    expect(second.deduped).toBe(true);
    expect(await jobsForIncident(r.incidentId!)).toHaveLength(1);
  });

  test('C1 correlation window: a fresh signal after close opens a NEW incident', async () => {
    const fingerprint = `slack:${randomUUID()}`;
    const first = await seedClosedFlapper(fingerprint, 'C_FLAP', `${Date.now()}.000601`);

    // The flapper re-fires, worse than last time.
    const second = await routeToIncident(__fixture.deps(), {
      tenantId: __fixture.tenantId,
      source: 'slack',
      fingerprint,
      service: 'checkout',
      severity: 'sev1',
      title: 'checkout 5xx again',
      origin: __fixture.origin('C_FLAP', `${Date.now()}.000602`),
    });
    expect(second.deduped).toBe(false);
    expect(second.incidentId).not.toBe(first.incidentId); // the closed incident is history, not this

    const rows = await incidentsFor(fingerprint);
    expect(rows).toHaveLength(2);

    // Occurrence stays closed. Resurrecting it rewrites a finished incident's record.
    const old = rows.find((r) => r.id === first.incidentId);
    expect(old).toMatchObject({ status: 'closed', severity: 'sev2', title: 'checkout 5xx' });

    // and occurrence is genuinely NEW: its own status and its own facts. Today the upsert's
    // `set: { updatedAt }` discards every one of these — the row still reads sev2 / 'checkout 5xx'.
    const fresh = rows.find((r) => r.id === second.incidentId);
    expect(fresh).toMatchObject({ status: 'open', severity: 'sev1', title: 'checkout 5xx again' });
  });
});
