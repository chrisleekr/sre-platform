import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EMBED_DIM, recordLearning, type Embedder, type KnowledgeFact } from '@sre/db';
import { createFixture } from './incidents.fixture';

// The review routes for saved learnings over HTTP, with a verified token per tenant: each tenant
// sees and deletes only its own facts.
const fx = createFixture();
const fakeEmbedder: Embedder = {
  dim: EMBED_DIM,
  embed: (texts) => Promise.resolve(texts.map(() => Array.from({ length: EMBED_DIM }, () => 0.1))),
};

const seed = async (tenantId: string, topic: string) =>
  recordLearning(fx.app.db, fakeEmbedder, tenantId, {
    topic,
    statement: `${topic} is recorded in the cluster manifest`,
    basis: 'observed',
    sourceIncidentId: randomUUID(),
  });

async function call(path: string, org: string, method = 'GET') {
  const init = fx.auth(await fx.sign(org));
  return fx.api.request(path, { ...init, method });
}

const topics = async (org: string) =>
  ((await (await call('/knowledge/facts', org)).json()) as { facts: KnowledgeFact[] }).facts.map(
    (fact) => fact.topic,
  );

describe('/knowledge/facts', () => {
  test('refuses a request without a verified identity', async () => {
    expect((await fx.api.request('/knowledge/facts')).status).toBe(401);
    expect(
      (await fx.api.request(`/knowledge/facts/${randomUUID()}`, { method: 'DELETE' })).status,
    ).toBe(401);
  });

  test('lists and deletes only the caller tenant facts', async () => {
    const suffix = randomUUID().slice(0, 8);
    const own = await seed(fx.tenantA, `A fact ${suffix}`);
    const foreign = await seed(fx.tenantB, `B fact ${suffix}`);

    expect(await topics(fx.orgA)).toContain(`A fact ${suffix}`);
    expect(await topics(fx.orgA)).not.toContain(`B fact ${suffix}`);
    expect((await call('/knowledge/facts?limit=0', fx.orgA)).status).toBe(400);

    expect((await call(`/knowledge/facts/${foreign.id}`, fx.orgA, 'DELETE')).status).toBe(404);
    expect((await call('/knowledge/facts/not-a-uuid', fx.orgA, 'DELETE')).status).toBe(404);
    expect((await call(`/knowledge/facts/${own.id}`, fx.orgA, 'DELETE')).status).toBe(204);
    expect((await call(`/knowledge/facts/${own.id}`, fx.orgA, 'DELETE')).status).toBe(404);
    expect(await topics(fx.orgA)).not.toContain(`A fact ${suffix}`);
    expect(await topics(fx.orgB)).toContain(`B fact ${suffix}`);
  });
});
