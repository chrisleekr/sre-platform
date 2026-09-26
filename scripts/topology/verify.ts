import assert from 'node:assert/strict';
import { verifyTopologyBrowser } from '../../apps/dashboard/checks/topology-browser';
import { randomUUID, randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { Queue, makeSnapshotCache } from '../../packages/queue/src/index';
import { eq } from 'drizzle-orm';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } from 'jose';
import {
  makeDb,
  tenants,
  connectorConfigs,
  persistTopologyDiscovery,
  recordTopologyDiscoveryFailure,
  readTopologyScans,
  makeSecretStore,
  investigationSubjects,
} from '../../packages/db/src/index';
import { seedMembership } from '../../packages/db/src/test-support';
import { makeApp } from '../../apps/api/src/app';
import { makeSubjectSyncResolver } from '../../apps/triage-worker/src/subject-sync';
import { resolveIncidentTopologyContext } from '../../packages/topology/src/index';
import {
  makeReadTopologyRuntimeTool,
  runTool,
  makeInMemoryAuditSink,
  makeReadTopologySourcesTool,
  makeReadTopologySourceFileTool,
  makeFetchBlastRadiusTool,
  makeDbAuditSink,
  connectorTools,
  makeReadTopologyEndpointTool,
  makeInvestigateCodeTool,
} from '../../packages/agent-tools/src/index';
import { makeNetworkProbeConnector } from '../../packages/connectors/src/index';
import { makeTestAuth } from '../../apps/api/src/__tests__/auth-test-support';
import { makeTopologyDiscoveryHandler } from '../../apps/triage-worker/src/topology-discovery';
import { startInfrastructure, ROOT } from '../docs/screenshots/harness';
import { topologyProviderFixture } from './provider-fixture';

// This entrypoint never starts the API/worker background loops or reads the developer database.
const stack = await startInfrastructure();
const admin = makeDb(stack.adminUrl);
const app = makeDb(stack.appDbUrl);
const redis = new Redis(stack.valkeyUrl, { maxRetriesPerRequest: null });
try {
  const tenantId = randomUUID(),
    otherTenant = randomUUID();
  const issuer = 'https://topology.example.test/';
  await admin.db.insert(tenants).values([
    { id: tenantId, name: 'Topology test' },
    { id: otherTenant, name: 'Other tenant' },
  ]);
  await seedMembership(admin.db, { issuer, subject: 'responder' }, tenantId, 'admin');
  await seedMembership(admin.db, { issuer, subject: 'other' }, otherTenant, 'admin');
  const keys = await generateKeyPair('RS256', { extractable: true });
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: 'topology-test',
    alg: 'RS256',
    use: 'sig',
  };
  const auth = await makeTestAuth({
    adminDb: admin.db,
    appDb: app.db,
    issuer,
    audience: 'topology-test',
    keys: createLocalJWKSet({ keys: [jwk] }),
    bindings: [
      { tenantId, subject: 'responder' },
      { tenantId: otherTenant, subject: 'other' },
    ],
  });
  const sign = (sub: string) =>
    new SignJWT({ sub })
      .setProtectedHeader({ alg: 'RS256', kid: 'topology-test' })
      .setIssuer(issuer)
      .setAudience('topology-test')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(keys.privateKey);
  const token = await sign('responder');
  const providers = topologyProviderFixture(tenantId);
  await admin.db.insert(connectorConfigs).values(
    providers.configs.map(({ id, type, name, settings }) => ({
      tenantId,
      id,
      type,
      name,
      settings,
    })),
  );
  const handler = makeTopologyDiscoveryHandler({
    scans: (tenant, generation) => readTopologyScans(app.db, tenant, generation),
    connectorProvider: (tenant) => async () => (tenant === tenantId ? providers.connectors : []),
    persist: (tenant, generation, result) =>
      persistTopologyDiscovery(app.db, tenant, generation, result),
    failed: (tenant, generation, at, issue) =>
      recordTopologyDiscoveryFailure(app.db, tenant, generation, at, issue),
  });
  const collect = async (ids = providers.connectors.map((connector) => connector.id)) => {
    for (const connectorId of ids)
      await handler({
        id: randomUUID(),
        tenantId,
        type: 'topology.discover',
        payload: { connectorId },
        attempts: 0,
      });
  };
  await collect();
  const kube = providers.connectors[0]!;
  let runtime = await kube.snapshot();
  const cache = makeSnapshotCache(redis);
  await cache.set(tenantId, 'kubernetes', runtime, 300, kube.generation);
  const api = makeApp({
    auth,
    appDb: app.db,
    readinessDb: app.db,
    cache,
    secrets: makeSecretStore(app.db, randomBytes(32).toString('base64')),
    settings: { list: async () => [], set: async () => 1 },
    declarationQueue: new Queue(admin.db, redis),
  });
  const response = await api.request('/topology/graph', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const graph = await response.json();
  assert.equal(graph.nodes.length, 0, 'Discovery must not require a manual catalog entry');
  const sourceService = graph.discovery.operational.subjects.find(
    (subject: { name: string }) => subject.name === 'catalog-api',
  );
  assert.equal(
    sourceService?.kind,
    'service',
    'Repository metadata must produce a persisted service',
  );
  assert.equal(
    sourceService.scope.environment,
    undefined,
    'Catalog lifecycle is not deployment environment',
  );
  assert.ok(
    graph.discovery.operational.relations.some(
      (relation: { from: string; kind: string }) =>
        relation.from === sourceService.key && relation.kind === 'declared_in',
    ),
  );
  const taggedService = graph.discovery.operational.subjects.find(
    (subject: { kind: string; name: string }) =>
      subject.kind === 'service' && subject.name === 'report-exporter',
  );
  assert.equal(taggedService?.scope.environment, 'production');
  assert.equal(
    taggedService?.resourceKeys.length,
    1,
    'Pod tags must reach persisted runtime membership',
  );
  assert.ok(
    graph.discovery.operational.relations.some(
      (relation: { from: string; kind: string; evidence: string }) =>
        relation.from === taggedService.key &&
        relation.kind === 'runs_on' &&
        relation.evidence === 'declared',
    ),
  );
  assert.equal(
    graph.discovery.operational.subjects.filter(
      (subject: { kind: string; name: string }) =>
        subject.kind === 'service' && subject.name === 'checkout',
    ).length,
    2,
    'Environments must stay separate',
  );
  assert.ok(
    graph.discovery.operational.relations.some(
      (relation: { kind: string }) => relation.kind === 'runs_on',
    ),
  );
  assert.ok(
    graph.discovery.operational.relations.some(
      (relation: { kind: string }) => relation.kind === 'calls',
    ),
  );
  assert.ok(
    graph.discovery.operational.relations.some(
      (relation: { kind: string }) => relation.kind === 'monitors',
    ),
  );
  const other = await api.request('/topology/graph', {
    headers: { authorization: `Bearer ${await sign('other')}` },
  });
  assert.equal(other.status, 200);
  assert.equal(
    (await other.json()).discovery.entities.length,
    0,
    'Tenant isolation must hold through the HTTP route',
  );

  let probeCalls = 0;
  await verifyTopologyBrowser({
    root: ROOT,
    token,
    readTopology: async (path, authorization, method, body) =>
      api.request(path, {
        method,
        body,
        headers: { authorization, 'content-type': 'application/json' },
      }),
    degradeProvider: async () => {
      providers.denyPrometheus();
      await collect([providers.configs[1]!.id]);
    },
    recordProbeEvidence: async (incidentId) => {
      const probe = makeNetworkProbeConnector(
        {
          id: randomUUID(),
          name: 'Built-in test probe',
          type: 'networkprobe',
          tenantId,
          settings: {},
          getCredential: async () => '',
        },
        {
          lookup: async () => ['93.184.216.34'],
          resolveCname: async () => [],
          tcpConnect: async () => 2,
          tlsConnect: async () => ({
            authorized: true,
            authorizationError: null,
            protocol: 'TLSv1.3',
            cipher: null,
            cert: { valid_to: '2027-01-01T00:00:00Z' },
          }),
          httpHead: async () => {
            probeCalls++;
            return {
              status: 503,
              headers: { 'set-cookie': 'private-cookie' },
              tlsAuthorized: true,
              tlsAuthorizationError: null,
              targetWithheld: false,
            };
          },
        },
      );
      const probeContext = {
        tenantId,
        incidentId,
        service: 'checkout',
        resolveConnectors: async () => [probe],
        audit: makeDbAuditSink({ db: app.db }),
      };
      for (const name of ['resolve_dns', 'check_reachable', 'inspect_tls', 'http_meta']) {
        const tool = connectorTools(probe).find((item) => item.name.endsWith(`_${name}`))!;
        const outcome = await runTool(
          tool,
          probeContext,
          name === 'http_meta'
            ? { url: 'https://checkout.example.test/metrics' }
            : { host: 'checkout.example.test' },
        );
        assert.ok(outcome.available);
      }
    },
  });
  assert.equal(
    probeCalls,
    1,
    'Browsing or refreshing endpoint evidence must not issue a new probe',
  );
  const [subject] = await admin.db
    .select()
    .from(investigationSubjects)
    .where(eq(investigationSubjects.tenantId, tenantId));
  assert.ok(subject, 'Browser action must persist an investigation subject');
  assert.equal(subject.sourceId, 'topology-discovery');
  assert.equal(subject.currentState, 'firing');
  assert.equal(subject.subjectId.length, 64, 'Durable identity must be bounded without truncation');
  const context = await resolveIncidentTopologyContext(app.db, tenantId, subject.incidentId);
  assert.equal(
    context?.topology.resolutions[0]?.subjectKey,
    subject.capturedSnapshot.topologySubjectKey,
    'Incident context must retain the exact discovered runtime identity',
  );
  const audit = makeInMemoryAuditSink();
  const tool = makeReadTopologyRuntimeTool({
    db: app.db,
    read: (tenant, source) => cache.get(tenant, source.type, source),
  });
  const result = await runTool(
    tool,
    {
      tenantId,
      incidentId: subject.incidentId,
      service: 'checkout',
      resolveConnectors: async () => providers.connectors,
      audit,
    },
    { subjectKey: subject.capturedSnapshot.topologySubjectKey },
  );
  assert.ok(result.available);
  assert.equal(result.data.status, 'partial');
  assert.equal(result.data.observations[0]?.state, 'attention');
  assert.equal(audit.records[0]?.tool, 'read_topology_runtime');
  const sourceContext = {
    tenantId,
    incidentId: subject.incidentId,
    service: 'checkout',
    resolveConnectors: async () => providers.connectors,
    audit,
  };
  const endpointSubject = graph.discovery.operational.subjects.find(
    (item: { kind: string; name: string }) =>
      item.kind === 'endpoint' && item.name === 'checkout.example.test/metrics',
  );
  assert.ok(endpointSubject);
  const endpointRead = await runTool(makeReadTopologyEndpointTool({ db: app.db }), sourceContext, {
    subjectKey: endpointSubject.key,
  });
  assert.ok(endpointRead.available);
  assert.equal(endpointRead.data.probes.length, 4);
  assert.ok(!JSON.stringify(endpointRead).includes('private-cookie'));
  const impact = await runTool(makeFetchBlastRadiusTool({ db: app.db }), sourceContext, {});
  assert.ok(impact.available);
  assert.equal(
    impact.data.subjectRef,
    subject.capturedSnapshot.topologySubjectKey,
    'Model-facing scope must survive the tool redactor',
  );
  const sources = await runTool(makeReadTopologySourcesTool({ db: app.db }), sourceContext, {
    subjectKey: impact.data.subjectRef,
  });
  assert.ok(sources.available);
  assert.deepEqual(sources.data.repositories.map((source) => source.role).sort(), [
    'application_source',
    'deployment_config',
  ]);
  const sourceFileTool = makeReadTopologySourceFileTool({ db: app.db });
  const code = await runTool(makeInvestigateCodeTool({ db: app.db }), sourceContext, {
    stackTrace: '/workspace/deployment.yaml:1',
  });
  assert.ok(code.available);
  assert.equal(code.data.status, 'located', JSON.stringify(code));
  assert.deepEqual(code.data.revisions.map((item) => item.revision).sort(), [
    'a'.repeat(40),
    'c'.repeat(40),
  ]);
  assert.ok(
    code.data.revisions.every(
      (item) =>
        item.basis === 'topology_declaration' &&
        item.strength === 'declared' &&
        item.topologyEvidenceRefs?.length,
    ),
  );
  for (const source of sources.data.repositories) {
    const sourceRead: Awaited<ReturnType<typeof sourceFileTool.handler>> = await runTool(
      sourceFileTool,
      sourceContext,
      {
        subjectKey: subject.capturedSnapshot.topologySubjectKey,
        sourceKey: source.identityRef,
        path: source.path ? `${source.path}/deployment.yaml` : 'README.md',
      },
    );
    assert.ok(sourceRead.available);
    assert.equal(sourceRead.data.status, 'read', JSON.stringify(sourceRead));
    assert.equal(sourceRead.data.file?.revision, source.revision);
  }
  const unauthenticated = await api.request('/topology/runtime?subjectKey=anything');
  assert.equal(unauthenticated.status, 401);
  for (const key of ['', 'x'.repeat(8193)]) {
    const invalid = await api.request(`/topology/runtime?subjectKey=${key}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(invalid.status, 400);
  }
  const sync = makeSubjectSyncResolver({ db: app.db, cache });
  runtime = runtime.map((snapshot) =>
    snapshot.topology
      ? { ...snapshot, topology: { ...snapshot.topology, state: 'healthy' as const } }
      : snapshot,
  );
  await cache.set(tenantId, 'kubernetes', runtime, 300, kube.generation);
  assert.equal(
    (await sync(tenantId, subject)).state,
    'unknown',
    'Healthy samples cannot establish service recovery',
  );
  await admin.db
    .update(connectorConfigs)
    .set({ enabled: false })
    .where(eq(connectorConfigs.id, providers.configs[2]!.id));
  const unavailable = await sync(tenantId, subject);
  assert.equal(unavailable.state, 'unknown');
  await admin.db
    .update(connectorConfigs)
    .set({ enabled: true })
    .where(eq(connectorConfigs.id, providers.configs[2]!.id));
  runtime = await kube.snapshot();
  await cache.set(tenantId, 'kubernetes', runtime, 300, kube.generation);
  assert.equal(
    (await sync(tenantId, { ...subject, currentSnapshot: unavailable.snapshot })).state,
    'firing',
    'Captured exact identity must survive a temporary discovery outage',
  );
  console.log(
    'PASS: isolated worker → Postgres → full API → browser → incident → runtime/source/endpoint tools → subject sync. Five inventory adapters plus the network probe use simulated transports; probe audits are durable and browsing issues no new probe; unsupported capabilities are explicit; exact source reads, tenant isolation, partial recovery and responsive screenshots pass. No model runs or external surface connections.',
  );
} finally {
  await redis.quit();
  await Promise.all([admin.close(), app.close()]);
  await Promise.all([stack.postgres.stop(), stack.valkey.stop()]);
}
