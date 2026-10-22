/**
 * Renders an investigation note from a distil that found no resolution: what was checked, ruled out
 * and still open, then any diagnostic guide, marked as unverified remediation.
 *
 * @param distil - The investigation fields of one distil result.
 */
export function noteContent(distil: {
  checked: string;
  ruledOut: string;
  openQuestions: string;
  diagnosticGuide?: string;
}): string {
  return [
    `Checked: ${distil.checked}`,
    `Ruled out: ${distil.ruledOut}`,
    `Open questions: ${distil.openQuestions}`,
    ...(distil.diagnosticGuide
      ? [`\nDiagnostic guide (unverified remediation):\n${distil.diagnosticGuide}`]
      : []),
  ].join('\n');
}
