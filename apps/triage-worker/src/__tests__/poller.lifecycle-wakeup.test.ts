// Pure-unit (no Postgres/Valkey): which poll jobs reconcile a lifecycle connector.
import { expect, test, vi } from 'vitest';

import type { IDataSourceConnector } from '@sre/connectors';

import { makePollHandler } from '../poller';

import { createFixture } from './poller.fixture';

const __fixture = createFixture();

function lifecycleHandler() {
  const connector: IDataSourceConnector = {
    ...__fixture.fakeConnector('statuscake', async () => []),
    capabilities: {
      availability: 'ready',
      configuration: 'tenant',
      instances: 'multiple',
      investigation: 'none',
      polling: 'none',
      events: 'authenticated',
      alertLifecycle: 'events_and_read',
    },
    alertLifecycle: { readEpisode: async () => ({ status: 'verified', observations: [] }) },
  };
  const reconcileLifecycle = vi.fn(async () => undefined);
  const ingestLifecycle = vi.fn(async () => undefined);
  const syncStatusCakeSetup = vi.fn(async () => undefined);
  const handler = makePollHandler({
    connectorProvider: () => async () => [connector],
    cache: __fixture.fakeCache().cache,
    ttlSec: 90,
    reconcileLifecycle,
    ingestLifecycle,
    syncStatusCakeSetup,
  });
  return { connector, handler, reconcileLifecycle, ingestLifecycle, syncStatusCakeSetup };
}

test('a scheduled poll reconciles the whole lifecycle connector', async () => {
  const { connector, handler, reconcileLifecycle, ingestLifecycle, syncStatusCakeSetup } =
    lifecycleHandler();
  await handler({
    id: 'scheduled',
    tenantId: 't1',
    type: 'poll',
    payload: { connectorId: connector.id },
    attempts: 1,
  });
  expect(reconcileLifecycle).toHaveBeenCalledTimes(1);
  expect(ingestLifecycle).not.toHaveBeenCalled();
  expect(syncStatusCakeSetup).toHaveBeenCalledExactlyOnceWith('t1', connector.id);
});

test('a provider wakeup ingests its monitor without a whole-connector reconcile', async () => {
  const { connector, handler, reconcileLifecycle, ingestLifecycle, syncStatusCakeSetup } =
    lifecycleHandler();
  const wakeup = { monitorId: '73', observedAt: '2026-09-22T00:00:00.000Z', lifecycleVersion: 0 };
  await handler({
    id: 'wakeup',
    tenantId: 't1',
    type: 'poll',
    payload: { connectorId: connector.id, ...wakeup },
    attempts: 1,
  });
  expect(reconcileLifecycle).not.toHaveBeenCalled();
  expect(ingestLifecycle).toHaveBeenCalledExactlyOnceWith('t1', connector, wakeup);
  // Each setup pass lists every test and contact group, so a wakeup flood must not trigger one.
  expect(syncStatusCakeSetup).not.toHaveBeenCalled();
});
