import { expect, test } from 'vitest';
import { parseObservationSubject } from '../support';

test.each(['', 'x'.repeat(8193), 'key\u0000', 'key\u001f', 'key\u007f'])(
  'rejects invalid topology subject keys',
  (subjectKey) => {
    expect(
      parseObservationSubject({ kind: 'topology_service', service: 'api', subjectKey }),
    ).toBeNull();
  },
);

test.each(['service:日本語', 'x'.repeat(8192), '["provider","service","api"]'])(
  'preserves valid topology subject keys exactly',
  (subjectKey) => {
    const subject = { kind: 'topology_service', service: 'api', subjectKey };
    expect(parseObservationSubject(subject)).toEqual(subject);
  },
);

test('observation resolvers share the route error constructors', async () => {
  const declared = await import('../../incident-observations');
  const topology = await import('../../observation-errors');
  for (const name of [
    'ObservationNotFoundError',
    'ObservationNotActionableError',
    'ObservationUnavailableError',
  ] as const)
    expect(new topology[name]()).toBeInstanceOf(declared[name]);
});
