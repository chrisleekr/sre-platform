import { describe, expect, test } from 'vitest';
import { incidentDisplayTitle } from '../incidentTitle';

describe('incident description rather than Slack addressing', () => {
  test('removes addressing mentions but preserves the requested diagnostic task', () => {
    expect(
      incidentDisplayTitle({
        title: '<@U0C1PMZKQQ0> can we check cluster health?',
        service: 'slack:channel',
      }),
    ).toBe('can we check cluster health?');
  });
  test('does not substitute transport or raw service identity for a missing description', () => {
    expect(incidentDisplayTitle({ title: '<@U0C1PMZKQQ0>', service: 'slack:channel' })).toBe(
      'Opening context unavailable',
    );
  });
  test('preserves a useful existing title and uncertainty', () => {
    expect(
      incidentDisplayTitle({ title: 'Possible database saturation', service: 'checkout' }),
    ).toBe('Possible database saturation');
  });
});
