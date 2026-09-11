import { describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Redis } from 'ioredis';

import { getBindingByIncident, getIncident, incidents, jobs, surfaceBindings } from '@sre/db';

import { routeToIncident, type IncidentSignal } from '../route-to-incident';

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

  test('routes through PostgreSQL when the advisory dedup cache is unavailable', async () => {
    const fingerprint = `slack:${randomUUID()}`;
    const redis = {
      set: vi.fn(async () => {
        throw new Error('Valkey unavailable');
      }),
      del: vi.fn(async () => 0),
    } as unknown as Redis;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    let routed: Awaited<ReturnType<typeof routeToIncident>>;
    try {
      routed = await routeToIncident(
        { ...__fixture.deps(), redis },
        {
          tenantId: __fixture.tenantId,
          source: 'slack',
          fingerprint,
          service: 'checkout',
          severity: 'sev2',
          origin: __fixture.origin('C_DEDUP_DOWN', `${Date.now()}.00001`),
        },
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('route.dedup_unavailable'));
    } finally {
      warn.mockRestore();
    }

    expect(routed).toMatchObject({ deduped: false, incidentId: expect.any(String) });
    expect(await incidentsFor(fingerprint)).toHaveLength(1);
    expect(await jobsForIncident(routed.incidentId!)).toHaveLength(1);
    expect(redis.del).not.toHaveBeenCalled();
  });

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

  test('C3 correlation window: the fresh signal binds to the NEW thread, so the AI answers where the human posted', async () => {
    const fingerprint = `slack:${randomUUID()}`;
    const oldThread = `${Date.now()}.000701`;
    const newThread = `${Date.now()}.000702`;
    const first = await seedClosedFlapper(fingerprint, 'C_FLAP_OLD', oldThread);

    const second = await routeToIncident(__fixture.deps(), {
      tenantId: __fixture.tenantId,
      source: 'slack',
      fingerprint,
      service: 'checkout',
      severity: 'sev2',
      origin: __fixture.origin('C_FLAP_NEW', newThread),
    });
    expect(second.deduped).toBe(false);

    // THE DAMAGE. The binding is the only thing that tells the fan-out where to speak, so the incident
    // being investigated must be bound to the thread the human is actually watching. Today this reads
    // C_FLAP_OLD/oldThread: triage narrates into the stale thread and the human never hears back.
    const binding = await getBindingByIncident(
      __fixture.app.db,
      __fixture.tenantId,
      'slack',
      second.incidentId!,
    );
    expect(binding).toBeDefined();
    expect(binding).toMatchObject({ channel: 'C_FLAP_NEW', threadId: newThread });

    // The new thread is owned — not silently unbound — by the incident that will answer in it.
    const newRows = await bindingsFor(`C_FLAP_NEW:${newThread}`);
    expect(newRows).toHaveLength(1);
    expect(newRows[0]).toMatchObject({ incidentId: second.incidentId, surface: 'slack' });

    // And the old thread keeps pointing at the closed incident it belonged to: history is not moved.
    const oldRows = await bindingsFor(`C_FLAP_OLD:${oldThread}`);
    expect(oldRows).toHaveLength(1);
    expect(oldRows[0]).toMatchObject({ incidentId: first.incidentId });
  });

  // --- a reused incident whose thread is already bound is NOT a new investigation -------------
  // The funnel reports created and reused identically, so it enqueues a triage job either way. On the
  // mention path the fingerprint is thread-derived (`slack:{channel}:{rootTs}` — the thread IS the
  // incident) and suppression is per-message, so a second human message in a thread whose
  // incident is still ACTIVE genuinely re-enters this write path: createIncident hands back the SAME
  // live incident, its binding is already there, and the job insert collides with the still-`queued`
  // first triage job on jobs_resume_coalesce_idx. 23505 -> the human's question dead-letters.
  //
  // The 23505 is load-bearing and stays (queue.test.ts): two triage jobs on one incident means two LLM
  // investigations narrating into the customer's thread. What must change is that the funnel never asks
  // for the second job, and `reused` is the whole condition: it implies the incident is ACTIVE, and
  // makes incident+binding atomic, so an ACTIVE incident always already has a binding.

  test('a reused incident on an ALREADY-BOUND thread enqueues no second triage job, and the tx commits', async () => {
    const fingerprint = `slack:${randomUUID()}`;
    const channel = 'C_REUSED';
    const threadId = `${Date.now()}.000801`;
    // Two distinct messages in ONE thread, exactly as the mention path emits them: one thread-derived
    // fingerprint (incident identity), a per-message dedupKey (redelivery suppression) —.
    const signal = (dedupKey: string, severity: string): IncidentSignal => ({
      tenantId: __fixture.tenantId,
      source: 'slack',
      fingerprint,
      service: 'checkout',
      severity,
      dedupTtlSec: 86_400,
      dedupKey,
      origin: __fixture.origin(channel, threadId),
    });

    const first = await routeToIncident(__fixture.deps(), signal('slack:C_REUSED:0801', 'sev3'));
    expect(first.deduped).toBe(false);
    // The first triage job is left `queued` ON PURPOSE — unlike the setups above that mark it done to
    // clear jobs_resume_coalesce_idx. A live investigation on the thread the human is posting in IS the
    // condition under test; clearing it would delete the bug. (`reused:false` on a genuine create is
    // That belongs to the reuse test, not this one: asserting it here would fail before the second signal ever runs,
    // and the second signal is the whole test.)

    const second = await routeToIncident(__fixture.deps(), signal('slack:C_REUSED:0802', 'sev1'));
    expect(second.deduped).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.incidentId).toBe(first.incidentId);
    // No second investigation asked for, so no 23505 to dead-letter the message.
    expect(second.jobId).toBeUndefined();
    expect(await jobsForIncident(first.incidentId!)).toHaveLength(1);

    // And this is a COMMIT, not the rollback the throw used to cause: the escalating re-alert's ratchet
    // and the thread binding both survive.
    expect(
      (await getIncident(__fixture.app.db, __fixture.tenantId, first.incidentId!))!.severity,
    ).toBe('sev1');
    expect(await incidentsFor(fingerprint)).toHaveLength(1);
    expect(await bindingsFor(`${channel}:${threadId}`)).toHaveLength(1);
  });

  test('b the same reuse with the first triage job past `queued` still enqueues nothing', async () => {
    // C3's twin, and the half only this file can see. jobs_resume_coalesce_idx is partial on
    // status='queued', so once the first triage job leaves 'queued' it drops OUT of the index and the
    // second insert would no longer 23505. It would quietly succeed. Same reuse, opposite failure: not a
    // dead-letter but a SECOND LLM investigation narrating into the customer's thread, and unrecoverable
    // once sent. So the gate cannot be "the index will catch it"; `reused` has to be the whole condition.
    //
    // The consumer-level tests cannot pin this: route() is a double there, so both outcomes reach the
    // consumer as the same `reused:true` (classify-consumer.correlation.test.ts).
    const fingerprint = `slack:${randomUUID()}`;
    const channel = 'C_REUSED_DONE';
    const threadId = `${Date.now()}.000901`;
    const signal = (dedupKey: string): IncidentSignal => ({
      tenantId: __fixture.tenantId,
      source: 'slack',
      fingerprint,
      service: 'checkout',
      severity: 'sev3',
      dedupTtlSec: 86_400,
      dedupKey,
      origin: __fixture.origin(channel, threadId),
    });

    const first = await routeToIncident(__fixture.deps(), signal('slack:C_REUSED_DONE:0901'));
    expect(first.deduped).toBe(false);
    // The condition under test, not a setup convenience: the first investigation has moved on, so the
    // index no longer holds a row for this incident and nothing but the funnel's own gate is left.
    await __fixture.admin.db
      .update(jobs)
      .set({ status: 'done' })
      .where(sql`id = ${first.jobId!}`);

    const second = await routeToIncident(__fixture.deps(), signal('slack:C_REUSED_DONE:0902'));
    expect(second.deduped).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.incidentId).toBe(first.incidentId);
    expect(second.jobId).toBeUndefined();
    // Still exactly one: the done job, and no second investigation beside it.
    expect(await jobsForIncident(first.incidentId!)).toHaveLength(1);
  });

  test('a genuine create reports reused:false and enqueues exactly ONE triage job', async () => {
    // The no-regression half: the fix must not cost the ordinary path its investigation.
    const fingerprint = `slack:${randomUUID()}`;
    const threadId = `${Date.now()}.001001`;
    const r = await routeToIncident(__fixture.deps(), {
      tenantId: __fixture.tenantId,
      source: 'slack',
      fingerprint,
      service: 'checkout',
      severity: 'sev2',
      origin: __fixture.origin('C_FRESH', threadId),
    });

    expect(r.deduped).toBe(false);
    expect(r.reused).toBe(false);
    expect(r.jobId).toBeTruthy();
    const jobRows = await jobsForIncident(r.incidentId!);
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]).toMatchObject({ id: r.jobId, type: 'triage', status: 'queued' });
  });

  test('a downstream failure releases the dedup reservation so the next signal can retry', async () => {
    // A tenant with no `tenants` row makes createIncident FK-violate, exercising the failure path.
    const ghostTenant = randomUUID();
    const fingerprint = `slo-burn:${randomUUID()}:fast`;
    const key = `dedup:${ghostTenant}:${fingerprint}`;
    await expect(
      routeToIncident(__fixture.deps(), {
        tenantId: ghostTenant,
        source: 'slo-burn',
        fingerprint,
        service: 'x',
        severity: 'sev2',
        origin: __fixture.origin('C_GHOST', `${Date.now()}.0005`),
      }),
    ).rejects.toThrow();
    // The reservation is released (ttl -2 = key absent), so the next eval tick is not suppressed.
    expect(await __fixture.redis.ttl(key)).toBe(-2);
  });
});
