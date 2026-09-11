import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { applyTriageResult, createIncident, getIncident, incidents, withTenant } from '../index';

// active-set query + occurrence bump. Namespace access so a not-yet-exported symbol
// reads as `undefined` (a per-assertion RED: "not a function") instead of an ESM link error that
// would break the existing passing tests in this module.
import * as incidentRepo from '../incident-repo';

import { createFixture } from './incident-repo.fixture';

const __fixture = createFixture();

// --- the correlation window is the ACTIVE window -------------------------------------------
// createIncident's "create-or-reuse on (tenant, fingerprint)" is correct only while the incident is
// still live. Once it is closed or resolved, reusing the row resurrects a finished incident: the funnel
// then keeps the OLD surface binding (surface_bindings_incident_uq -> onConflictDoNothing) and triage
// answers in a thread nobody is reading. The window must close with the incident, while "exactly one
// ACTIVE incident per fingerprint" keeps holding — that is what makes it a WINDOW and not a free-for-all.
describe('correlation window', () => {
  const rowsFor = (fp: string) =>
    __fixture.admin.db
      .select()
      .from(incidents)
      .where(sql`tenant_id = ${__fixture.tenantA} and fingerprint = ${fp}`);

  test('C1 a CLOSED/RESOLVED incident is not resurrected: a fresh signal opens a NEW row', async () => {
    // Both terminal statuses, not just the sweep's: 'resolved' is terminal, so a re-fire after a human
    // resolved the incident is likewise a new incident, not an edit of the resolved one.
    for (const status of ['closed', 'resolved'] as const) {
      const fp = `fp-${randomUUID()}`;
      const { id: first } = await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: fp,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
        title: 'first occurrence',
      });
      await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, first, status);

      const { id: second } = await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: fp,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev1',
        title: 'second occurrence',
      });
      expect(second, `a ${status} incident must not be reused`).not.toBe(first);
      expect(await rowsFor(fp)).toHaveLength(2);

      // The terminal row is untouched history; the new row carries the new signal's own facts.
      expect(await getIncident(__fixture.app.db, __fixture.tenantA, first)).toMatchObject({
        status,
        severity: 'sev2',
      });
      expect(await getIncident(__fixture.app.db, __fixture.tenantA, second)).toMatchObject({
        status: 'open',
        severity: 'sev1',
        title: 'second occurrence',
      });
    }
  });

  test('C2 an ACTIVE incident is REUSED, whatever its lifecycle state', async () => {
    for (const status of ['open', 'mitigated'] as const) {
      const fp = `fp-${randomUUID()}`;
      const { id: first } = await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: fp,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      });
      await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, first, status);

      const { id: second } = await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: fp,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      });
      expect(second, `status=${status} must reuse the live incident`).toBe(first);
      expect(await rowsFor(fp)).toHaveLength(1);
      expect(await getIncident(__fixture.app.db, __fixture.tenantA, first)).toMatchObject({
        status,
      });
    }
  });

  // --- severity ratchets on the ACTIVE-reuse path ------------------------------------------
  // C2 above pins that an ACTIVE re-alert REUSES the row. The reuse was `set: { updatedAt }` only, so the
  // incoming signal's severity was discarded and a re-alert could never raise an incident.
  //
  // Alertmanager reaches this ACTIVE reuse path after its bounded provider-episode router selects an
  // existing incident. These tests isolate the severity rule from that adapter decision.
  //
  // Ratchet, not overwrite, and it ratchets TOWARD sev1: sev1 is the MOST severe rank (classify-consumer
  // routes the degraded fail-open "at the lowest severity" with DEGRADED_SEVERITY = 'sev3'), so escalation
  // means moving DOWN the number. A later, calmer re-fire must not walk the incident back down while
  // humans are working it at the higher rank.
  //
  // `severity` is free text by design (route-to-incident.ts: "source and severity are free text"; the
  // column is `text`, NewIncident.severity is `string`), so an unrecognised value has no rank and must be
  // treated as no information in BOTH directions: it never escalates over a known rank (C11), and a known
  // rank always escalates over it (C11b).

  test('C9 severity ratchets UP: an escalating re-alert wins on the ACTIVE-reuse path', async () => {
    const fp = `fp-${randomUUID()}`;
    const { id: first } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });

    const { id: second } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev1',
    });
    expect(second).toBe(first); // the ACTIVE-reuse path, same row
    expect(await rowsFor(fp)).toHaveLength(1);

    const row = await getIncident(__fixture.app.db, __fixture.tenantA, first);
    expect(row!.severity).toBe('sev1');
  });

  test('C10 severity ratchets ONE WAY: a calmer re-alert does not de-escalate a live incident', async () => {
    const fp = `fp-${randomUUID()}`;
    const { id: first } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev1',
    });

    const { id: second } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    expect(second).toBe(first);

    const row = await getIncident(__fixture.app.db, __fixture.tenantA, first);
    expect(row!.severity).toBe('sev1');
  });

  test('C11 severity ratchets on known ranks only: an unknown severity does not de-escalate', async () => {
    // 'sev9' is not a rank the platform knows. Engine tests use it precisely because the column is free
    // text, so the ratchet must ignore it rather than rank it below sev2.
    const fp = `fp-${randomUUID()}`;
    const { id: first } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });

    const { id: second } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev9',
    });
    expect(second).toBe(first);

    const row = await getIncident(__fixture.app.db, __fixture.tenantA, first);
    expect(row!.severity).toBe('sev2');
  });

  test('C11b severity ratchets over an unknown: a known rank escalates a live unknown', async () => {
    // C11's mirror, and NOT symmetric with it: C11 pins that an unknown never escalates over a known,
    // this pins that a known always escalates over an unknown. A live incident can genuinely hold 'sev9'
    // because severity is free text, and the fail-safe is only complete if it escapes.
    //
    // This is the case an asymmetric rank would break while C9/C10/C11 all still passed: give
    // severityRank's `else` a different value on the incidents side (say 0), and a live 'sev9' ranks 0,
    // an incoming 'sev2' ranks 2, `2 < 0` is false — the incident is pinned at 'sev9' forever. C9 (1<3),
    // C10 (3<1 false) and C11 (99<2 false) are all blind to it, since none has an unknown on the LIVE
    // side. severityRank takes the side as a parameter, so that asymmetry is one edit away.
    const fp = `fp-${randomUUID()}`;
    const { id: first } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev9',
    });

    const { id: second } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    expect(second).toBe(first);

    const row = await getIncident(__fixture.app.db, __fixture.tenantA, first);
    expect(row!.severity).toBe('sev2');
  });

  // --- createIncident reports whether it INSERTED or REUSED --------------------------------
  // The funnel cannot tell the two apart today, so a human's @mention in a thread whose incident is still
  // ACTIVE re-enters routeToIncident, reuses that incident (C2 above), and tries to enqueue a SECOND
  // triage job for it: 23505 on jobs_resume_coalesce_idx, and the question dead-letters.
  //
  // The detector is `RETURNING (xmax = 0)`. A genuine INSERT leaves the new tuple's xmax at 0; ON CONFLICT
  // DO UPDATE self-locks the tuple it updates, so xmax is non-zero (a concurrent KEY SHARE locker only
  // turns it into a MultiXactId — still non-zero). That is a Postgres IMPLEMENTATION DETAIL, not a
  // documented contract, and `xmax` appears nowhere else in this repo: these two tests, against a real
  // Postgres in both directions, are the only thing pinning it. A mock would prove nothing here.
  //
  // Rejected: `created_at = updated_at`. created_at is timestamp(3) and updated_at timestamp(6)
  // (migrations/0000_damp_the_professor.sql), so one now() rounds to ms while the other keeps µs and a
  // genuine INSERT reads created_at <> updated_at ~99.9% of the time — a detector that reports `reused`
  // for almost every create.

  test('a genuine INSERT reports reused:false', async () => {
    const fp = `fp-${randomUUID()}`;
    const created = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    expect(created.reused).toBe(false);
    expect(await getIncident(__fixture.app.db, __fixture.tenantA, created.id)).toMatchObject({
      status: 'open',
    });
    expect(await rowsFor(fp)).toHaveLength(1);

    // Still an INSERT when the arbiter EXISTS but does not fire: a TERMINAL sibling holds the
    // fingerprint, so the active-only partial unique does not match and the row is genuinely new.
    // The two cases run different code inside Postgres — this one takes the speculative-insertion path,
    // which parks its token in t_ctid rather than xmax — so both are pinned, not just the easy one.
    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, created.id, 'closed');
    const afterClose = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    expect(afterClose.reused).toBe(false);
    expect(afterClose.id).not.toBe(created.id);
    expect(await rowsFor(fp)).toHaveLength(2);
  });

  test('a conflict on incidents_active_fingerprint_uq reports reused:true and still ratchets severity', async () => {
    const fp = `fp-${randomUUID()}`;
    const first = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });

    const second = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev1',
    });
    expect(second).toEqual({ id: first.id, reused: true });
    expect(await rowsFor(fp)).toHaveLength(1);
    // Both halves of the upsert on the SAME statement: the detector rides the RETURNING clause, so it
    // must not displace `set` — the escalating re-alert still ratchets the live incident up.
    expect((await getIncident(__fixture.app.db, __fixture.tenantA, first.id))!.severity).toBe(
      'sev1',
    );
  });

  // the status vocabulary is enforced by the DB, not by a comment. Lives here rather than in
  // schema-ddl.test.ts because incidents.tenant_id FKs to tenants, and this file owns that fixture.
  // The catalog shape is asserted in schema-ddl.test.ts; this proves Postgres actually REJECTS the write.
  test("C12 a typo'd status is rejected at write time, not silently accepted", async () => {
    // The failure this closes: 'Open' falls outside incidents_active_fingerprint_uq's predicate, so the
    // typo'd row escapes the partial index and a SECOND active incident for the fingerprint becomes
    // insertable — the correlation window silently stops being a window. Raw insert on the admin
    // connection: createIncident cannot express a status outside IncidentStatus, and the point is to
    // prove the guard holds for writers that bypass the repo.
    let err: { code?: string; cause?: { code?: string } } | undefined;
    try {
      await __fixture.admin.db.execute(
        sql`insert into incidents (tenant_id, fingerprint, alert_source, service, severity, status)
            values (${__fixture.tenantA}, ${`fp-${randomUUID()}`}, 'slack', 'checkout', 'sev2', 'Open')`,
      );
    } catch (e) {
      err = e as typeof err;
    }
    expect(err, "status 'Open' was ACCEPTED: the vocabulary CHECK is not enforced").toBeDefined();
    // 23514 = check_violation. The CODE, not just any throw: a NOT NULL miss would throw too. drizzle
    // wraps DB errors so the SQLSTATE is on `.cause.code` (see composite-fk.test.ts).
    expect(err?.code ?? err?.cause?.code).toBe('23514');
  });

  test('C8 two concurrent fresh signals after the close arbitrate onto ONE new incident', async () => {
    const fp = `fp-${randomUUID()}`;
    const { id: closed } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, closed, 'closed');

    // The index only ever arbitrates against COMMITTED rows, so two signals racing after the close both
    // find no active incident and both INSERT. The loser MUST arbitrate onto the winner's row: if it
    // 23505'd instead, routeToIncident would roll back AND release the dedup key, and that page would be
    // dropped for good rather than retried. Force the overlap rather than hoping the scheduler produces
    // it — A holds its tx open, uncommitted, across B's insert.
    let releaseA!: () => void;
    const aMayCommit = new Promise<void>((r) => (releaseA = r));
    let markInserted!: () => void;
    const aHasInserted = new Promise<void>((r) => (markInserted = r));

    const aPromise = withTenant(__fixture.app.db, __fixture.tenantA, async (tx) => {
      const { id } = await createIncident(tx, __fixture.tenantA, {
        fingerprint: fp,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
      });
      markInserted();
      await aMayCommit;
      return id;
    });
    await aHasInserted;

    let bDone = false;
    const bPromise = createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev1',
    }).then(({ id }) => {
      bDone = true;
      return id;
    });

    // B must BLOCK on A's speculative insertion until A commits. A B that sailed through is the real
    // failure this test exists for: it would mean the two inserts never arbitrated against each other,
    // and one fingerprint is about to have two live incidents and two triage runs.
    await new Promise((r) => setTimeout(r, 300));
    expect(bDone, 'B did not block on A: the two inserts never arbitrated').toBe(false);

    releaseA();
    const [idA, idB] = await Promise.all([aPromise, bPromise]);

    // Which one wins is up to the scheduler; that they agree is not. The loser upserted onto the
    // winner's row rather than raising, so the second signal is folded in, not dropped.
    expect(idB).toBe(idA);
    expect(idA).not.toBe(closed); // ...and neither resurrected the closed row
    const rows = await rowsFor(fp);
    expect(rows).toHaveLength(2); // the closed history row + exactly ONE new live incident
    expect(rows.filter((r) => r.status !== 'closed')).toHaveLength(1);
  });

  // Conversation advances its exactly-once watermark without changing lifecycle. An explicit audited
  // reopen is separately protected against colliding with the active sibling.
  const seedClosedPlusLiveSibling = async (fp: string) => {
    const { id: closed } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    await __fixture.setLifecycle(__fixture.app.db, __fixture.tenantA, closed, 'closed');
    const { id: live } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    expect(live).not.toBe(closed); // the state this PR's partial index newly permits
    return { closed, live };
  };

  test('conversation on a closed incident does not collide with its live sibling', async () => {
    const fp = `fp-${randomUUID()}`;
    const { closed, live } = await seedClosedPlusLiveSibling(fp);

    await incidentRepo.advanceResumeWatermark(
      __fixture.app.db,
      __fixture.tenantA,
      closed,
      'reply-1',
    );

    const x = await getIncident(__fixture.app.db, __fixture.tenantA, closed);
    // The engagement is recorded — the watermark advanced, so the reply is consumed exactly-once and a
    // redelivery is still a no-op. The human gets their answer in T1 either way.
    expect(x?.lastResumeMessageId).toBe('reply-1');
    // ...but the status does NOT move: Y owns the fingerprint's active window, so X stays history.
    expect(x?.status).toBe('closed');
    expect((await getIncident(__fixture.app.db, __fixture.tenantA, live))?.status).toBe('open'); // untouched
    expect(await rowsFor(fp)).toHaveLength(2); // still exactly one active + one terminal
  });

  test('C9 a late triage result on a closed incident does not collide with its live sibling', async () => {
    const fp = `fp-${randomUUID()}`;
    const { closed, live } = await seedClosedPlusLiveSibling(fp);

    await applyTriageResult(__fixture.app.db, __fixture.tenantA, closed, {
      provider: 'claude',
      sessionId: 's',
      summary: 'LATE RCA',
      confidence: 60,
    });

    const x = await getIncident(__fixture.app.db, __fixture.tenantA, closed);
    // The RCA is still recorded (Option B): the finding is worth keeping...
    expect(x?.rcaSummary).toBe('LATE RCA');
    // ...without dragging X back into an active window its sibling already owns.
    expect(x?.status).toBe('closed');
    expect((await getIncident(__fixture.app.db, __fixture.tenantA, live))?.status).toBe('open');
  });

  test('C4 two ACTIVE incidents cannot share (tenant, fingerprint)', async () => {
    const fp = `fp-${randomUUID()}`;
    const { id: live } = await createIncident(__fixture.app.db, __fixture.tenantA, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });

    // A raw insert, deliberately bypassing createIncident's ON CONFLICT clause: exactly-one-active-per-
    // fingerprint has to be enforced by the DATABASE, not by the upsert's good manners. Whatever index
    // shape lands on, a second ACTIVE row for a live fingerprint must still be rejected — otherwise
    // two triage runs narrate into two threads for one problem.
    const err = await __fixture.admin.db
      .insert(incidents)
      .values({
        tenantId: __fixture.tenantA,
        fingerprint: fp,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev2',
        status: 'open',
      })
      .catch((e: unknown) => e);
    // Assert the SQLSTATE, not just "it threw": drizzle wraps the driver error in a generic "Failed
    // query" whose message would also match a not-null or FK violation, making a bare toThrow() vacuous.
    // 23505 = unique_violation, on the cause the driver attaches.
    expect((err as { cause?: { code?: string } })?.cause?.code).toBe('23505');
    expect(await rowsFor(fp)).toHaveLength(1);

    // Cross-tenant: the same fingerprint under another tenant is a different incident, never a conflict.
    const { id: otherTenant } = await createIncident(__fixture.app.db, __fixture.tenantB, {
      fingerprint: fp,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    expect(otherTenant).not.toBe(live);
  });
});
