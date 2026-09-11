// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test } from 'vitest';
import { SegmentedTabs } from '../SegmentedTabs';

function TabsHarness() {
  const [value, setValue] = useState('week');
  return (
    <SegmentedTabs
      label="Reliability period"
      value={value}
      panelId="reliability-period"
      onChange={setValue}
      items={[
        { id: 'week', label: 'Week' },
        { id: 'month', label: 'Month' },
        { id: 'quarter', label: 'Quarter' },
      ]}
    />
  );
}

describe('SegmentedTabs', () => {
  test('uses one tab stop and supports horizontal tab keyboard navigation', () => {
    render(<TabsHarness />);

    const week = screen.getByRole('tab', { name: 'Week' });
    const month = screen.getByRole('tab', { name: 'Month' });
    const quarter = screen.getByRole('tab', { name: 'Quarter' });
    expect(week.tabIndex).toBe(0);
    expect(month.tabIndex).toBe(-1);
    expect(quarter.tabIndex).toBe(-1);

    week.focus();
    fireEvent.keyDown(week, { key: 'ArrowRight' });
    expect(week.getAttribute('aria-selected')).toBe('true');
    expect(month.getAttribute('aria-selected')).toBe('false');
    expect(document.activeElement).toBe(month);

    fireEvent.keyDown(month, { key: 'Enter' });
    expect(month.getAttribute('aria-selected')).toBe('true');
    expect(month.tabIndex).toBe(0);

    fireEvent.keyDown(month, { key: 'End' });
    expect(month.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(quarter);

    fireEvent.keyDown(quarter, { key: ' ' });
    expect(quarter.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(quarter, { key: 'ArrowRight' });
    expect(quarter.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(week);
  });

  test('sizes the track from the number of supplied tabs', () => {
    render(<TabsHarness />);

    expect(screen.getByRole('tablist').getAttribute('style')).toBe(
      'grid-template-columns: repeat(3, minmax(0, 1fr));',
    );
  });
});
