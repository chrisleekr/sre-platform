import { describe, expect, test } from 'vitest';
import { assessmentLabel } from '../incidentState';

describe('assessmentLabel', () => {
  test.each([
    ['queued', 'queued'],
    ['gathering', 'gathering evidence'],
    ['assessed', 'assessment available'],
    ['degraded', 'needs human'],
  ] as const)(
    'maps %s investigation progress independently of lifecycle and RCA',
    (state, label) => {
      expect(assessmentLabel({ investigationStatus: state })).toBe(label);
    },
  );
});
