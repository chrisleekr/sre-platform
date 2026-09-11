// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InlineAlert, StatePanel } from '../PageState';

describe('StatePanel', () => {
  test('reserves first-load space and exposes one polite loading status (C1, C6)', () => {
    const { container } = render(
      <StatePanel state="loading" title="Loading infrastructure" skeleton="table" />,
    );

    expect(container.firstElementChild?.className).toMatch(/min-h-/);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByRole('status').textContent).toMatch(/loading infrastructure/i);
    expect(screen.getByRole('status').getAttribute('data-skeleton-variant')).toBe('table');
    expect(container.querySelector('.sre-skeleton')).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('renders contextual empty copy without announcing a failure (C2, C6)', () => {
    render(
      <StatePanel
        state="empty"
        title="No connectors configured"
        description="Connect a source to begin collecting infrastructure data."
      />,
    );

    expect(screen.getByText('No connectors configured')).toBeDefined();
    expect(screen.getByText(/begin collecting infrastructure data/i)).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('offers retry only when the caller supplies a safe retry (C3)', () => {
    const retry = vi.fn();
    const { rerender } = render(
      <StatePanel
        state="error"
        title="Could not load connectors"
        description="The connector list could not be retrieved."
      />,
    );

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();

    rerender(
      <StatePanel
        state="error"
        title="Could not load connectors"
        description="The connector list could not be retrieved."
        onRetry={retry}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});

describe('InlineAlert', () => {
  test('owns one alert region and keeps a safe retry inside it (C3, C6)', () => {
    const retry = vi.fn();
    render(<InlineAlert message="Could not load older deployments." onRetry={retry} />);

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
