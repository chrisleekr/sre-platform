import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import type { IDataSourceConnector, SourceCodeReader, SourceRepository } from '@sre/connectors';
import {
  agentToolCalls,
  applySignalObservation,
  createIncident,
  deployments,
  getIncidentEvidence,
  incidents,
  incidentSignals,
  makeDb,
  tenants,
  upsertDeployments,
  type DbHandle,
} from '@sre/db';
import { makeInvestigateCodeTool } from '../code-intelligence';
import { makeDbAuditSink } from '../db-audit-sink';
import { runTool } from '../dispatch';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

const DEPLOYED_SHA = '4e4d8a061459d15b95dc8d48d7c2f6f4be0e1234';
const POST_ONSET_SHA = '5e5d8a061459d15b95dc8d48d7c2f6f4be0e5678';
const DATA_SOURCE_ID = '00000000-0000-4000-8000-000000000123';

let admin: DbHandle;
let app: DbHandle;
let tenantId: string;
let incidentId: string;

const repository: SourceRepository = {
  dataSourceId: DATA_SOURCE_ID,
  dataSourceName: 'GitHub production',
  provider: 'github',
  repositoryId: '42',
  fullName: 'acme/checkout',
  defaultBranch: 'main',
  webUrl: 'https://github.com/acme/checkout',
  pathPrefix: null,
  mappingSource: null,
  role: 'application_source',
  resolution: 'confirmed_mapping',
};

const sourceReader: SourceCodeReader = {
  async resolve() {
    return [repository];
  },
  async verifyRevision(_repository, revision) {
    if (revision !== DEPLOYED_SHA) throw new Error('unexpected revision');
    return {
      revision: DEPLOYED_SHA,
      providerUrl: `https://github.com/acme/checkout/commit/${DEPLOYED_SHA}`,
    };
  },
  async search() {
    return { matches: [], incomplete: false };
  },
  async read(_repository, revision, path) {
    if (revision !== DEPLOYED_SHA || path !== 'src/checkout.ts')
      throw new Error('source not found');
    const lines = Array.from({ length: 60 }, (_, index) =>
      index === 41
        ? "export function chargeAccount() { throw new Error('account missing'); }"
        : `// line ${index + 1}`,
    );
    return {
      path,
      revision,
      text: lines.join('\n'),
      providerUrl: `https://github.com/acme/checkout/blob/${revision}/${path}`,
    };
  },
  async compare() {
    return {
      files: [],
      filesIncomplete: false,
    };
  },
};

const connector: IDataSourceConnector = {
  id: DATA_SOURCE_ID,
  name: 'GitHub production',
  type: 'github',
  sourceCode: sourceReader,
  async snapshot() {
    return [];
  },
  async fetchTriageContext() {
    return { source: 'github', data: {} };
  },
  tools() {
    return [];
  },
  async probe() {
    return { status: 'healthy', reachable: true, authorized: true, warnings: [] };
  },
};

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'code-intelligence-acceptance' });
  incidentId = (
    await createIncident(app.db, tenantId, {
      fingerprint: `code-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
  await applySignalObservation(app.db, tenantId, {
    incidentId,
    provider: 'alertmanager',
    providerFingerprint: 'checkout-errors',
    startsAt: new Date('2026-08-28T00:30:00Z'),
    surface: 'slack',
    channel: 'C-CODE-TEST',
    externalMessageId: `alert-${randomUUID()}`,
    state: 'firing',
    summary: 'checkout account errors',
    contentHash: randomUUID(),
    eventKey: randomUUID(),
    eventAt: new Date('2026-08-29T00:00:00Z'),
  });
  await upsertDeployments(
    app.db,
    tenantId,
    [
      {
        source: 'github',
        providerId: `deploy-${randomUUID()}`,
        repo: 'acme/checkout',
        ref: 'main',
        sha: DEPLOYED_SHA,
        service: 'checkout',
        status: 'success',
        deployedAt: new Date('2026-08-28T00:00:00Z'),
      },
      {
        source: 'github',
        providerId: `deploy-${randomUUID()}`,
        repo: 'acme/checkout',
        ref: 'main',
        sha: POST_ONSET_SHA,
        service: 'checkout',
        status: 'success',
        deployedAt: new Date('2026-08-28T01:00:00Z'),
      },
    ],
    DATA_SOURCE_ID,
  );
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(agentToolCalls).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(deployments).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(incidentSignals).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(incidents).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('revision-aware code investigation acceptance', () => {
  test('persists exact deployed source as a bounded code evidence projection', async () => {
    const inventedEvidenceId = randomUUID();
    const result = await runTool(
      makeInvestigateCodeTool({ db: app.db }),
      {
        tenantId,
        incidentId,
        service: 'checkout',
        resolveConnectors: async () => [connector],
        audit: makeDbAuditSink({ db: app.db }),
      },
      {
        stackTrace: 'Error: account missing\n    at chargeAccount (/srv/src/checkout.ts:42:7)',
        evidenceIds: [inventedEvidenceId],
      },
    );

    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected code evidence');
    expect(result.data.status).toBe('located');
    expect(result.data.revisions[0]).toMatchObject({
      revision: DEPLOYED_SHA,
      basis: 'deployment_event',
      strength: 'corroborated',
    });
    expect(result.data.evidence[0]?.sourceEvidenceIds).toEqual([]);

    const stored = await getIncidentEvidence(app.db, tenantId, incidentId, result.evidenceId);
    expect(stored?.tool).toBe('investigate_code');
    expect(stored?.projection).toMatchObject({
      kind: 'code',
      status: 'located',
      matches: [
        {
          repository: 'acme/checkout',
          revision: DEPLOYED_SHA,
          path: 'src/checkout.ts',
          startLine: 32,
          endLine: 52,
        },
      ],
    });
    expect(JSON.stringify(stored?.projection).length).toBeLessThan(20_000);
  });
});
