// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { EvidenceDetail } from '../../lib/types';
import { IncidentEvidencePreview } from '../IncidentEvidencePreview';

const base: EvidenceDetail = {
  id: 'evidence-1',
  tool: 'statuscake_AAAAAAAAAAAAAAAAAAAAAA_get_test',
  outcome: 'error',
  failure: 'not_found',
  latencyMs: 5,
  recordedAt: '2026-08-29T00:00:00Z',
  hasOutput: false,
  input: {},
  output: null,
  projection: { kind: 'facts', columns: ['failure'], rows: [{ failure: 'not_found' }] },
  referenceUrl: null,
};

describe('IncidentEvidencePreview', () => {
  test('shows no projected preview for a failed check', () => {
    const { container } = render(<IncidentEvidencePreview detail={base} />);
    expect(container.textContent).toBe('');
  });

  // Control: the same projection on a successful check renders, so the empty result above is not vacuous.
  test('shows the projected facts preview for a successful check', () => {
    const { container } = render(
      <IncidentEvidencePreview detail={{ ...base, outcome: 'data', failure: null }} />,
    );
    expect(container.textContent).toContain('Preview of projected facts');
  });
});
