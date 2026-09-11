import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { createIncident, withTenant } from '../index';

import { approvals, surfaceBindings } from '../schema';

import {
  activateSurfaceBinding,
  advanceSurfaceStatusPost,
  advanceSurfaceStatusPostByBinding,
  createApproval,
  decideApproval,
  getApproval,
  getBindingByExternal,
  getBindingByIncident,
  getSurfaceStatusPost,
  recordSurfaceBinding,
} from '../surface-repo';

import { createFixture } from './surface-repo.fixture';

const __fixture = createFixture();

describe('surface bindings', () => {
  test('record is idempotent per (surface, incident); bidirectional lookup', async () => {
    const first = await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: __fixture.incidentId,
      surface: 'slack',
      channel: 'C123',
      threadId: '169.1',
    });
    expect(first.externalId).toBe('C123:169.1'); // generated from channel + thread_id

    // A second bind for the same (surface, incident) is a no-op even with a different thread, and it
    // RETURNS the existing row rather than undefined — the caller needs the thread that actually won.
    const dup = await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: __fixture.incidentId,
      surface: 'slack',
      channel: 'C123',
      threadId: '999',
    });
    expect(dup.externalId).toBe('C123:169.1'); // the first binding still owns the incident

    const byIncident = await getBindingByIncident(
      __fixture.app.db,
      __fixture.tenantId,
      'slack',
      __fixture.incidentId,
    );
    expect(byIncident).toMatchObject({ channel: 'C123', threadId: '169.1' });
    expect(
      (await getBindingByExternal(__fixture.app.db, __fixture.tenantId, 'slack', 'C123:169.1'))
        ?.incidentId,
    ).toBe(__fixture.incidentId);
  });

  test('lifecycle status projection advances monotonically and remains tenant scoped', async () => {
    expect(
      await getSurfaceStatusPost(
        __fixture.app.db,
        __fixture.tenantId,
        'slack',
        __fixture.incidentId,
      ),
    ).toEqual({
      messageId: null,
      version: 0,
    });
    expect(
      await advanceSurfaceStatusPost(
        __fixture.app.db,
        __fixture.tenantId,
        'slack',
        __fixture.incidentId,
        'status-ts',
        0,
      ),
    ).toBe(true);
    expect(
      await advanceSurfaceStatusPost(
        __fixture.app.db,
        __fixture.tenantId,
        'slack',
        __fixture.incidentId,
        'stale-ts',
        0,
      ),
    ).toBe(false);
    expect(
      await advanceSurfaceStatusPost(
        __fixture.app.db,
        __fixture.tenantId,
        'slack',
        __fixture.incidentId,
        'status-ts',
        2,
      ),
    ).toBe(true);
    expect(
      await getSurfaceStatusPost(
        __fixture.app.db,
        __fixture.tenantId,
        'slack',
        __fixture.incidentId,
      ),
    ).toEqual({
      messageId: 'status-ts',
      version: 2,
    });
    expect(
      await getSurfaceStatusPost(__fixture.app.db, randomUUID(), 'slack', __fixture.incidentId),
    ).toBeNull();
  });

  test('a lifecycle delivery cannot advance a thread after its assignment generation changes', async () => {
    const binding = await getBindingByIncident(
      __fixture.app.db,
      __fixture.tenantId,
      'slack',
      __fixture.incidentId,
    );
    expect(binding).toBeDefined();
    const originalGeneration = binding!.assignmentVersion;
    await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx
        .update(surfaceBindings)
        .set({ assignmentVersion: originalGeneration + 1 })
        .where(eq(surfaceBindings.id, binding!.id)),
    );

    expect(
      await advanceSurfaceStatusPostByBinding(
        __fixture.app.db,
        __fixture.tenantId,
        'slack',
        binding!.id,
        __fixture.incidentId,
        originalGeneration,
        'late-old-owner-status',
        3,
      ),
    ).toBe(false);
    expect(
      await advanceSurfaceStatusPostByBinding(
        __fixture.app.db,
        __fixture.tenantId,
        'slack',
        binding!.id,
        __fixture.incidentId,
        originalGeneration + 1,
        'current-owner-status',
        3,
      ),
    ).toBe(true);
  });

  // A DIFFERENT incident claiming a thread that is already taken must NOT raise (the insert runs inside
  // the incident's own transaction; a raise would roll the incident back, Slack would redeliver, and it
  // would collide again — an unbreakable retry loop). It no-ops and returns the row that OWNS the thread,
  // which is the caller's real question: a taken thread is the ANSWER to "which incident owns this
  // conversation", not an error. Returning undefined left the caller with nothing to act on but a throw.
  test('a thread already bound to another incident does not raise; it returns the OWNING row', async () => {
    const { id: other } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const taken = await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: other,
      surface: 'slack',
      channel: 'C123',
      threadId: '169.1', // already bound to `incidentId` above
    });
    // The winner, not the newcomer: the caller learns who it must attach the message to.
    expect(taken.incidentId).toBe(__fixture.incidentId);
    expect(taken.externalId).toBe('C123:169.1');
    // ...and the original owner is untouched.
    expect(
      (await getBindingByExternal(__fixture.app.db, __fixture.tenantId, 'slack', 'C123:169.1'))
        ?.incidentId,
    ).toBe(__fixture.incidentId);
  });

  // Our incident (bound to T1) re-bound to a FREE thread T2: the incident_uq conflict no-ops, so T2 is
  // NOT bound. The row handed back must be the T1 binding that actually exists — never a pretence that T2
  // won — or the funnel would publish a triage job believing the alert's thread is answerable while the
  // incident is still answered in T1. Unreachable today (fingerprints are thread-derived); a future
  // non-chat source with a stable service-level fingerprint re-firing in a new thread lands exactly here.
  test('an incident already bound to another thread returns the EXISTING binding; the new thread is not bound', async () => {
    const { id: moved } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: moved,
      surface: 'slack',
      channel: 'C777',
      threadId: 'T1',
    });

    const again = await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: moved,
      surface: 'slack',
      channel: 'C777',
      threadId: 'T2', // free
    });
    expect(again).toMatchObject({ incidentId: moved, externalId: 'C777:T1' });
    // T2 really is unbound — the caller must not be told otherwise.
    expect(
      await getBindingByExternal(__fixture.app.db, __fixture.tenantId, 'slack', 'C777:T2'),
    ).toBeUndefined();
  });

  test('activating a correlated thread makes it the full reply destination', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'payments',
      severity: 'sev2',
    });
    const original = await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-ACTIVE',
      threadId: 'old-root',
    });
    const recurring = await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-ACTIVE',
      threadId: 'new-root',
      role: 'source',
    });

    await activateSurfaceBinding(__fixture.app.db, __fixture.tenantId, 'slack', id, recurring.id);

    expect(
      await getBindingByIncident(__fixture.app.db, __fixture.tenantId, 'slack', id),
    ).toMatchObject({
      id: recurring.id,
      role: 'primary',
      projectionMode: 'full',
    });
    expect(
      await getBindingByExternal(
        __fixture.app.db,
        __fixture.tenantId,
        'slack',
        'C-ACTIVE:old-root',
      ),
    ).toMatchObject({
      id: original.id,
      role: 'source',
      projectionMode: 'status',
    });
  });

  test('a correlated thread becomes primary when the incident had no surface conversation', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'manual',
      service: 'search',
      severity: 'sev2',
    });
    const binding = await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-FIRST',
      threadId: 'first-root',
      role: 'source',
    });

    await activateSurfaceBinding(__fixture.app.db, __fixture.tenantId, 'slack', id, binding.id);

    expect(
      await getBindingByIncident(__fixture.app.db, __fixture.tenantId, 'slack', id),
    ).toMatchObject({
      id: binding.id,
      role: 'primary',
      projectionMode: 'full',
    });
  });

  test('a correlation in another channel cannot receive the full investigation', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'identity',
      severity: 'sev2',
    });
    const primary = await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-PRIVATE',
      threadId: 'private-root',
    });
    const correlated = await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-PUBLIC',
      threadId: 'public-root',
      role: 'source',
    });

    await activateSurfaceBinding(__fixture.app.db, __fixture.tenantId, 'slack', id, correlated.id);

    expect(
      await getBindingByIncident(__fixture.app.db, __fixture.tenantId, 'slack', id),
    ).toMatchObject({
      id: primary.id,
      role: 'primary',
      projectionMode: 'full',
    });
    expect(
      await getBindingByExternal(
        __fixture.app.db,
        __fixture.tenantId,
        'slack',
        'C-PUBLIC:public-root',
      ),
    ).toMatchObject({
      id: correlated.id,
      role: 'source',
      projectionMode: 'status',
    });
  });

  test('activation joins the caller transaction and rolls back with later work', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'orders',
      severity: 'sev2',
    });
    const original = await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-ROLLBACK',
      threadId: 'original',
    });
    const correlated = await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-ROLLBACK',
      threadId: 'correlated',
      role: 'source',
    });

    await expect(
      withTenant(__fixture.app.db, __fixture.tenantId, async (tx) => {
        await activateSurfaceBinding(tx, __fixture.tenantId, 'slack', id, correlated.id);
        throw new Error('later correlation write failed');
      }),
    ).rejects.toThrow('later correlation write failed');

    expect(
      await getBindingByIncident(__fixture.app.db, __fixture.tenantId, 'slack', id),
    ).toMatchObject({
      id: original.id,
      role: 'primary',
      projectionMode: 'full',
    });
  });

  test('concurrent activations preserve exactly one primary conversation', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'billing',
      severity: 'sev2',
    });
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-RACE',
      threadId: 'original',
    });
    const sources = await Promise.all(
      ['recurrence-a', 'recurrence-b'].map((threadId) =>
        recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
          incidentId: id,
          surface: 'slack',
          channel: 'C-RACE',
          threadId,
          role: 'source',
        }),
      ),
    );

    await Promise.all(
      sources.map((binding) =>
        activateSurfaceBinding(__fixture.app.db, __fixture.tenantId, 'slack', id, binding.id),
      ),
    );

    const bindings = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx.select().from(surfaceBindings).where(eq(surfaceBindings.incidentId, id)),
    );
    expect(bindings.filter((binding) => binding.role === 'primary')).toHaveLength(1);
    expect(bindings.filter((binding) => binding.projectionMode === 'full')).toHaveLength(1);
  });
});

describe('approvals', () => {
  test('create; first-decision-wins CAS is idempotent across surfaces', async () => {
    const actionId = `act-${randomUUID().slice(0, 8)}`;
    await createApproval(__fixture.app.db, __fixture.tenantId, {
      incidentId: __fixture.incidentId,
      actionId,
      prompt: 'Restart checkout?',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'deny', label: 'Deny' },
      ],
    });

    // Slack taps approve first; a racing deny from another surface loses (first decision wins).
    expect(
      await decideApproval(
        __fixture.app.db,
        __fixture.tenantId,
        __fixture.incidentId,
        actionId,
        'approve',
        'u-slack',
      ),
    ).toBe(true);
    expect(
      await decideApproval(
        __fixture.app.db,
        __fixture.tenantId,
        __fixture.incidentId,
        actionId,
        'deny',
        'u-other',
      ),
    ).toBe(false);

    const a = await getApproval(
      __fixture.app.db,
      __fixture.tenantId,
      __fixture.incidentId,
      actionId,
    );
    expect(a?.decision).toBe('approve');
    expect(a?.decidedBy).toBe('u-slack');
  });

  // the ON CONFLICT DO NOTHING + re-select DISCARDS whether it actually inserted, so the worker
  // cannot tell a first proposal from a redelivered one and appends the kind='approval' hub message
  // (the button block) unconditionally — two buttons, one of them undecidable. Report the bit.
  test('/C10 createApproval reports whether it INSERTED: first call true, redelivery false', async () => {
    const actionId = `approval:${randomUUID().replace(/-/g, '').slice(0, 32)}`;
    const input = {
      incidentId: __fixture.incidentId,
      actionId,
      prompt: 'Restart checkout?',
      options: [{ id: 'approve', label: 'Approve' }],
    };

    const first = await createApproval(__fixture.app.db, __fixture.tenantId, input);
    expect(first.inserted).toBe(true);
    expect(first.row.actionId).toBe(actionId);

    // The redelivered turn re-creates the identical proposal: same row, and the caller is told so.
    const again = await createApproval(__fixture.app.db, __fixture.tenantId, input);
    expect(again.inserted).toBe(false);
    expect(again.row.id).toBe(first.row.id);

    const rows = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx.select().from(approvals).where(eq(approvals.actionId, actionId)),
    );
    expect(rows).toHaveLength(1);
  });

  // the action_id format changes (provider tool-call id -> content hash), but a decision is
  // keyed on the approvals PK, so rows already written with a `toolu_*` action_id stay decidable.
  test('an approval carrying a legacy toolu_* action_id is still decidable', async () => {
    const actionId = `toolu_${randomUUID().slice(0, 8)}`;
    await createApproval(__fixture.app.db, __fixture.tenantId, {
      incidentId: __fixture.incidentId,
      actionId,
      prompt: 'Restart checkout?',
      options: [{ id: 'approve', label: 'Approve' }],
    });

    expect(
      await decideApproval(
        __fixture.app.db,
        __fixture.tenantId,
        __fixture.incidentId,
        actionId,
        'approve',
        'u-legacy',
      ),
    ).toBe(true);
    expect(
      (await getApproval(__fixture.app.db, __fixture.tenantId, __fixture.incidentId, actionId))
        ?.decision,
    ).toBe('approve');
  });
});
