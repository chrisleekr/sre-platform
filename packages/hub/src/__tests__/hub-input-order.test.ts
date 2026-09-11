import { randomUUID } from 'node:crypto';
import {
  createIncident,
  humanMessagesSince,
  humanMessageFenceMatchesTx,
  withTenant,
} from '@sre/db';
import { expect, test } from 'vitest';
import { createFixture } from './hub.fixture';

const fixture = createFixture();

test('a late append from an older transaction sorts after consumed human input', async () => {
  const incident = await createIncident(fixture.app.db, fixture.tenantA, {
    fingerprint: randomUUID(),
    alertSource: 'manual',
    service: 'checkout',
    severity: 'sev3',
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const olderTransaction = withTenant(fixture.app.db, fixture.tenantA, async (tx) => {
    entered();
    await ready;
    return fixture.hub.appendTx(tx, fixture.tenantA, incident.id, {
      author: 'human',
      authorUserId: fixture.memberUserId,
      content: 'Do not close; new failures appeared.',
    });
  });
  await started;
  const consumed = await fixture.hub.append(fixture.tenantA, incident.id, {
    author: 'human',
    authorUserId: fixture.memberUserId,
    content: 'Please close the case.',
  });
  release();
  const newer = await olderTransaction;
  expect(Date.parse(newer.createdAt)).toBeGreaterThan(Date.parse(consumed.createdAt));
  expect(
    await humanMessagesSince(fixture.app.db, fixture.tenantA, incident.id, consumed.id),
  ).toEqual([expect.objectContaining({ id: newer.id })]);
  expect(
    await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
      humanMessageFenceMatchesTx(tx, incident.id, consumed.id),
    ),
  ).toBe(false);
});
