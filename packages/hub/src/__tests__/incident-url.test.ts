import { describe, expect, test } from 'vitest';
import { incidentUrl } from '../incident-url';

describe('incidentUrl', () => {
  test('builds a dashboard deep-link when the base is set', () => {
    expect(incidentUrl('https://app.example.com', 'inc-123')).toBe(
      'https://app.example.com/w/incidents/inc-123',
    );
  });

  test('strips a single trailing slash on the base', () => {
    expect(incidentUrl('https://app.example.com/', 'inc-123')).toBe(
      'https://app.example.com/w/incidents/inc-123',
    );
  });

  test('returns null when the base is undefined (feature unconfigured)', () => {
    expect(incidentUrl(undefined, 'inc-123')).toBeNull();
  });
});
