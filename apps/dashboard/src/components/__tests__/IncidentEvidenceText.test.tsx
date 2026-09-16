// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { IncidentEvidenceText } from '../IncidentEvidenceText';

afterEach(cleanup);

test('a page boundary inside an astral character keeps the character whole', () => {
  // 5,999 ASCII characters put the emoji's two UTF-16 units across the 6,000-unit boundary.
  const text = `${'a'.repeat(5999)}🚀${'b'.repeat(10)}`;
  render(<IncidentEvidenceText text={text} label="Output" />);
  const page = () => screen.getByLabelText('Output').textContent ?? '';
  expect(page().endsWith('a🚀')).toBe(true);
  expect(page()).not.toContain('�');

  fireEvent.click(screen.getByRole('button', { name: 'Next Output page' }));
  expect(page()).toBe('b'.repeat(10));
});
