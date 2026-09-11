import { describe, expect, test } from 'vitest';
import { incidentPath, productPath } from '../routes';

describe('canonical dashboard paths', () => {
  test('constructs static and dynamic product links below one workspace root', () => {
    expect(productPath()).toBe('/w');
    expect(productPath('connectors')).toBe('/w/connectors');
    expect(productPath('/settings/members')).toBe('/w/settings/members');
    expect(incidentPath('incident / 1')).toBe('/w/incidents/incident%20%2F%201');
  });
});
