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
