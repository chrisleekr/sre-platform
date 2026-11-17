import { describe, expect, test } from 'vitest';
import { evidenceFailureDetail, evidenceOutcomeLabel, toolDisplayLabel } from '../toolPresentation';

const KEY = 'AAAAAAAAAAAAAAAAAAAAAA';

describe('toolDisplayLabel', () => {
  test('names every StatusCake tool', () => {
    const label = (name: string) => toolDisplayLabel(`statuscake_${KEY}_${name}`);
    expect(label('list_tests')).toBe('StatusCake · checks');
    expect(label('get_test')).toBe('StatusCake · check detail');
    expect(label('get_test_history')).toBe('StatusCake · check history');
    expect(label('get_uptime_periods')).toBe('StatusCake · uptime periods');
    expect(label('get_uptime_alerts')).toBe('StatusCake · uptime alerts');
    expect(label('list_maintenance_windows')).toBe('StatusCake · maintenance windows');
    expect(label('list_contact_groups')).toBe('StatusCake · contact groups');
    expect(label('api_get')).toBe('StatusCake · API read');
  });

  test('labels any provider api_get as an API read', () => {
    expect(toolDisplayLabel(`prometheus_${KEY}_api_get`)).toBe('Prometheus · API read');
  });

  test('keeps Prometheus alerts as active alerts', () => {
    expect(toolDisplayLabel(`prometheus_${KEY}_alerts`)).toBe('Prometheus · active alerts');
  });
});

describe('evidenceOutcomeLabel', () => {
  test('shows a known failure reason', () => {
    const label = (failure: string) => evidenceOutcomeLabel('error', failure);
    expect(label('not_found')).toBe('Check failed: not found');
    expect(label('timeout')).toBe('Check failed: timed out');
    expect(label('permission_denied')).toBe('Check failed: access denied');
    expect(label('rate_limited')).toBe('Check failed: rate limited');
    expect(label('unreachable')).toBe('Check failed: source unreachable');
    expect(label('target_not_allowed')).toBe('Check failed: target not allowed');
    expect(label('provider_error')).toBe('Check failed: provider error');
  });

  test('falls back to Check failed for an absent or unknown category', () => {
    expect(evidenceOutcomeLabel('error', undefined)).toBe('Check failed');
    expect(evidenceOutcomeLabel('error', null)).toBe('Check failed');
    expect(evidenceOutcomeLabel('error', 'bogus')).toBe('Check failed');
    expect(evidenceOutcomeLabel('error', 'constructor')).toBe('Check failed');
  });

  test('ignores failure on a data row', () => {
    expect(evidenceOutcomeLabel('data', 'not_found')).toBe('Data returned');
  });

  test('explains a failed check in one sentence', () => {
    expect(evidenceFailureDetail('timeout')).toBe(
      'The source did not answer in time, so nothing was read.',
    );
    expect(evidenceFailureDetail('permission_denied')).toBe(
      'The connection is not allowed to read this, so nothing was read.',
    );
    expect(evidenceFailureDetail('not_found')).toBe(
      'The source has nothing matching this request as named or as this type.',
    );
    expect(evidenceFailureDetail('rate_limited')).toBe(
      'The source limited requests, so nothing was read.',
    );
    expect(evidenceFailureDetail('unreachable')).toBe(
      'The source could not be reached, so nothing was read.',
    );
    expect(evidenceFailureDetail('target_not_allowed')).toBe(
      'The platform does not allow reading this target, so nothing was read.',
    );
    expect(evidenceFailureDetail('provider_error')).toBe(
      'The source returned an error, so nothing was read.',
    );
    for (const unknown of [undefined, null, 'bogus', 'constructor'])
      expect(evidenceFailureDetail(unknown)).toBe('The check failed before returning data.');
  });
});
