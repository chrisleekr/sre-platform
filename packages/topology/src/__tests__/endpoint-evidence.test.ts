import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  agentToolCalls,
  connectorConfigs,
  incidents,
  makeDb,
  persistTopologyDiscovery,
  tenants,
  type DbHandle,
} from '@sre/db';
import { networkProbeTopologyEvidence } from '@sre/connectors';
import { topologyRefKey } from '@sre/contracts';
import { readTopologyEndpointEvidence } from '../endpoint-evidence';
import { readDiscoveredTopology } from '../discovery-repo';

const tenantId = randomUUID(),
  otherTenant = randomUUID(),
  sourceId = randomUUID(),
  incidentId = randomUUID();
const endpoint = {
  authority: 'http-endpoint',
  kind: 'endpoint',
  id: 'https://service.example/status',
};
const tool = (operation: string) => `networkprobe_${'A'.repeat(22)}_${operation}`;
let admin: DbHandle, app: DbHandle;
beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values([
    { id: tenantId, name: 'Endpoint evidence' },
    { id: otherTenant, name: 'Other tenant' },
  ]);
  await admin.db.insert(connectorConfigs).values([
    { id: sourceId, tenantId, type: 'prometheus', name: 'Private source name' },
    { tenantId, type: 'kubernetes', name: 'Pending collection' },
    { tenantId, type: 'gitlab', name: 'Disabled source', enabled: false },
  ]);
  await admin.db.insert(incidents).values({
    id: incidentId,
    tenantId,
    fingerprint: incidentId,
    service: 'service',
    alertSource: 'slack',
    severity: 'sev3',
  });
  await persistTopologyDiscovery(
    app.db,
    tenantId,
    { id: sourceId, lifecycleVersion: 0 },
    {
      observedAt: new Date().toISOString(),
      collections: [
        {
          key: 'targets',
          completeness: 'complete',
          entities: [
            {
              ref: endpoint,
              kind: 'endpoint',
              name: 'service.example/status',
              scope: {},
              attributes: {},
            },
          ],
          relations: [],
        },
      ],
    },
  );
});
afterAll(async () => {
  await admin.db.delete(agentToolCalls).where(eq(agentToolCalls.tenantId, tenantId));
  await admin.db.delete(incidents).where(eq(incidents.id, incidentId));
  await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
  await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
  await admin.db.delete(tenants).where(eq(tenants.id, otherTenant));
  await Promise.all([admin.close(), app.close()]);
});
const record = async (
  operation: string,
  input: unknown,
  output: unknown,
  ago = 1000,
  outcome = 'data',
) => {
  const id = randomUUID();
  await admin.db.insert(agentToolCalls).values({
    id,
    tenantId,
    incidentId,
    tool: tool(operation),
    input,
    output,
    outcome,
    latencyMs: 1,
    createdAt: new Date(Date.now() - ago),
  });
  return id;
};

test('distinguishes configured pending disabled builtin and unsupported capabilities without tenant leakage', async () => {
  const graph = await readDiscoveredTopology(app.db, tenantId);
  expect(graph.capabilities).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'kubernetes', state: 'pending' }),
      expect.objectContaining({ type: 'prometheus', state: 'collected' }),
      expect.objectContaining({ type: 'gitlab', state: 'disabled' }),
      expect.objectContaining({
        type: 'networkprobe',
        connectorId: null,
        mode: 'on_demand',
        state: 'on_demand',
      }),
      expect.objectContaining({ type: 'aws', mode: 'unsupported', state: 'unsupported' }),
      expect.objectContaining({ type: 'confluence', mode: 'unsupported', state: 'unsupported' }),
    ]),
  );
  expect(
    JSON.stringify((await readDiscoveredTopology(app.db, otherTenant)).capabilities),
  ).not.toContain('Private source name');
});

test('uses audited endpoint facts without a networkprobe connector row or shared-IP identity inference', async () => {
  await record(
    'http_meta',
    { url: endpoint.id },
    {
      url: endpoint.id,
      targetIp: '93.184.216.34',
      status: 503,
      headers: { 'set-cookie': 'must-not-expose', authorization: 'must-not-expose' },
    },
  );
  await record(
    'http_meta',
    { url: 'https://other.example/status' },
    { url: 'https://other.example/status', targetIp: '93.184.216.34', status: 200 },
  );
  await record(
    'resolve_dns',
    { host: 'service.example' },
    { host: 'service.example', addresses: [{ ip: '93.184.216.34' }] },
  );
  const evidence = await readTopologyEndpointEvidence(app.db, tenantId, topologyRefKey(endpoint));
  expect(evidence.probes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'http', facts: { status: 503 }, stale: false }),
      expect.objectContaining({ kind: 'dns', facts: { addresses: ['93.184.216.34'] } }),
    ]),
  );
  expect(JSON.stringify(evidence)).not.toContain('must-not-expose');
  expect(
    (await readTopologyEndpointEvidence(app.db, otherTenant, topologyRefKey(endpoint))).probes,
  ).toEqual([]);
});

test('matches protocol and port and marks old evidence stale', async () => {
  await record(
    'inspect_tls',
    { host: 'service.example', port: 8443 },
    { host: 'service.example', port: 8443, authorized: false },
  );
  await record(
    'inspect_tls',
    { host: 'service.example', port: 443 },
    { host: 'service.example', port: 443, authorized: true, valid_to: '2027-01-01T00:00:00Z' },
    600_000,
  );
  const evidence = await readTopologyEndpointEvidence(app.db, tenantId, topologyRefKey(endpoint));
  expect(evidence.probes.find((probe) => probe.kind === 'tls')).toMatchObject({
    stale: true,
    facts: { authorized: true, expiresAt: '2027-01-01T00:00:00.000Z' },
  });
});

test('a newer failed probe is not hidden behind an earlier successful observation', async () => {
  await record(
    'check_reachable',
    { host: 'service.example' },
    { host: 'service.example', port: 443, reachable: true },
    5000,
  );
  await record('check_reachable', { host: 'service.example' }, null, 1, 'error');
  const evidence = await readTopologyEndpointEvidence(app.db, tenantId, topologyRefKey(endpoint));
  expect(evidence.probes.find((probe) => probe.kind === 'tcp')).toMatchObject({
    state: 'unavailable',
    facts: {},
  });
});

test('one probe kind and wrong-port repeats cannot hide other matching evidence', async () => {
  await admin.db.delete(agentToolCalls).where(eq(agentToolCalls.tenantId, tenantId));
  const expected = [
    await record(
      'resolve_dns',
      { host: 'service.example' },
      { addresses: [{ ip: '93.184.216.34' }] },
      5000,
    ),
    await record(
      'check_reachable',
      { host: 'service.example', port: 443 },
      { reachable: true },
      5000,
    ),
    await record('inspect_tls', { host: 'service.example', port: 443 }, { authorized: true }, 5000),
  ];
  await admin.db.insert(agentToolCalls).values(
    Array.from({ length: 120 }, (_, index) => ({
      id: randomUUID(),
      tenantId,
      incidentId,
      tool: tool('http_meta'),
      input: { url: endpoint.id },
      output: { status: 200 },
      outcome: 'data',
      latencyMs: 1,
      createdAt: new Date(Date.now() - 3000 - index),
    })),
  );
  await admin.db.insert(agentToolCalls).values(
    Array.from({ length: 120 }, () => ({
      id: randomUUID(),
      tenantId,
      incidentId,
      tool: tool('check_reachable'),
      input: { host: 'service.example', port: 443 },
      output: { host: 'service.example', port: 8443, reachable: false },
      outcome: 'data',
      latencyMs: 1,
      createdAt: new Date(Date.now() - 1000),
    })),
  );
  await record(
    'check_reachable',
    { host: 'service.example', port: 443 },
    { host: 123, port: 443, reachable: false },
  );
  await record(
    'check_reachable',
    { host: 'service.example', port: 443 },
    { host: 'service.example', port: '443', reachable: false },
  );
  await record(
    'http_meta',
    { url: endpoint.id },
    { url: 'https://other.example/status', status: 201 },
  );
  const result = await readTopologyEndpointEvidence(app.db, tenantId, topologyRefKey(endpoint));
  expect(result.probes.map((probe) => probe.kind).sort()).toEqual(['dns', 'http', 'tcp', 'tls']);
  expect(result.probes.map((probe) => probe.evidenceId)).toEqual(expect.arrayContaining(expected));
  expect(result.probes.find((probe) => probe.kind === 'http')?.facts.status).toBe(200);
  expect(result.note).not.toContain('lookup reached its limit');
});

test('omitted probe ports retain the audited operation default rather than the endpoint port', () => {
  const now = new Date();
  const row = {
    id: randomUUID(),
    incidentId,
    tool: tool('check_reachable'),
    input: { host: 'service.example' },
    output: { reachable: true },
    outcome: 'data',
    createdAt: now,
  };
  expect(networkProbeTopologyEvidence(new URL('http://service.example'), row, now)).toBeNull();
  expect(
    networkProbeTopologyEvidence(new URL('https://service.example'), row, now)?.facts.reachable,
  ).toBe(true);
  expect(
    networkProbeTopologyEvidence(
      new URL('http://service.example'),
      { ...row, input: { ...row.input, port: 80 } },
      now,
    )?.facts.reachable,
  ).toBe(true);
});
