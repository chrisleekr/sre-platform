import { entityCandidateKey, type AffectedEntityCandidate } from '@sre/contracts';
import { expect, test } from 'vitest';
import { makeArgoCdConnector } from '../connector';
import { conn, fakeFetch, lookup, multiCfg } from './test-helpers';

const serviceCandidate = (name: string): AffectedEntityCandidate => ({
  key: entityCandidateKey('service', name),
  kind: 'service',
  stableId: name,
  displayName: name,
  scope: {},
  provenance: { kind: 'classifier_inference', source: 'test' },
  confidence: 80,
  observedAt: '2026-08-31T00:00:00.000Z',
  completeness: 'partial',
  requiredCapabilities: ['deployments'],
});

test('single-project coverage requires an application inside the configured boundary', async () => {
  const connector = conn(fakeFetch().impl);

  expect(await connector.entityCoverage!.assess(serviceCandidate('checkout'))).toBe('covered');
  expect(await connector.entityCoverage!.assess(serviceCandidate('inventory'))).toBe(
    'out_of_scope',
  );

  const wildcard = conn(fakeFetch().impl, {
    settings: {
      applicationsInAnyNamespace: false,
      applications: [{ project: 'payments', name: '*' }],
    },
  });
  expect(await wildcard.entityCoverage!.assess(serviceCandidate('inventory'))).toBe('covered');
});

test('multi-project coverage checks every configured application without claiming unknown services', async () => {
  const connector = makeArgoCdConnector(multiCfg(), fakeFetch().impl, lookup);

  expect(await connector.entityCoverage!.assess(serviceCandidate('checkout'))).toBe('covered');
  expect(await connector.entityCoverage!.assess(serviceCandidate('login'))).toBe('covered');
  expect(await connector.entityCoverage!.assess(serviceCandidate('inventory'))).toBe(
    'out_of_scope',
  );
});
