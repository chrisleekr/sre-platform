import { expect, test } from 'vitest';
import { topologyReferences } from '../topology-references';
import { redactInput } from '../redact';

test('preserves typed correlation references while credentials and free-form scopes remain redacted', () => {
  expect(
    redactInput(
      topologyReferences({
        subjectKey: 'service-ref',
        key: 'source-ref',
        resourceKeys: ['pod-ref'],
        privateKey: 'credential-value',
        scope: { key: 'scope-secret', apiKey: 'api-secret' },
        attributes: { key: 'attribute-secret' },
      }),
    ),
  ).toEqual({
    subjectRef: 'service-ref',
    identityRef: 'source-ref',
    resourceRefs: ['pod-ref'],
    privateKey: '[REDACTED]',
    scope: { key: '[REDACTED]', apiKey: '[REDACTED]' },
    attributes: { key: '[REDACTED]' },
  });
});
