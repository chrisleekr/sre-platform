import { expect, test } from 'vitest';
import { isCorrectedDiagnosticGuide } from '../incident-flow-cases';

test('an unchanged unsafe numbered draft cannot pass the correction check', () => {
  expect(isCorrectedDiagnosticGuide('# Runbook\n1. Restart the operator, the proven fix.')).toBe(
    false,
  );
  expect(
    isCorrectedDiagnosticGuide('# Diagnostic guide\nCause unresolved.\n1. Restart the operator.'),
  ).toBe(false);
  expect(
    isCorrectedDiagnosticGuide(
      '# Diagnostic guide\nCause unresolved.\n1. Inspect and attribute I/O before considering remediation.',
    ),
  ).toBe(true);
});
