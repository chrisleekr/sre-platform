import { expect, test } from 'vitest';
import { topologyReferences } from '../topology-references';

test('renames correlation keys to references and passes other values through', () => {
  expect(
    topologyReferences({
      subjectKey: 'service-ref',
      key: 'source-ref',
      resourceKeys: ['pod-ref'],
      privateKey: 'credential-value',
      scope: { key: 'scope-secret', apiKey: 'api-secret' },
      attributes: { key: 'attribute-secret' },
    }),
  ).toEqual({
    subjectRef: 'service-ref',
    identityRef: 'source-ref',
    resourceRefs: ['pod-ref'],
    privateKey: 'credential-value',
    scope: { key: 'scope-secret', apiKey: 'api-secret' },
    attributes: { key: 'attribute-secret' },
  });
});
