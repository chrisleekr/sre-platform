// @vitest-environment jsdom
// Proves shared auto-cleanup: without cleanup() between tests, renders in a file accumulate in
// document.body, so a second render of the same text yields TWO matches. This file has NO explicit
// afterEach(cleanup) — it passes only when auto-cleanup is registered (vitest globals:true makes
// @testing-library/react self-register afterEach(cleanup)).
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

function Probe() {
  return <div>isolation-probe</div>;
}

test('first render mounts the probe', () => {
  render(<Probe />);
  expect(screen.getByText('isolation-probe')).toBeTruthy();
});

test('second render sees only its own instance (prior render was cleaned up)', () => {
  render(<Probe />);
  expect(screen.getAllByText('isolation-probe')).toHaveLength(1);
});
