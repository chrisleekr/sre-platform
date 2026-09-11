// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  ApplicationLoadingSkeleton,
  InlineLoadingSkeleton,
  LoadingSkeleton,
  SkeletonRows,
} from '../LoadingSkeleton';

describe('LoadingSkeleton', () => {
  test('announces one named loading state while keeping its visual geometry decorative', () => {
    const { container } = render(
      <LoadingSkeleton label="Loading infrastructure…" variant="table" />,
    );

    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Loading infrastructure…');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.getAttribute('data-skeleton-variant')).toBe('table');
    expect(container.querySelectorAll('.sre-skeleton').length).toBeGreaterThan(10);
    expect(status.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  test('can defer announcements to a page-owned live region', () => {
    const { container } = render(
      <LoadingSkeleton label="Loading incidents…" variant="list" announce={false} />,
    );

    expect(screen.queryByRole('status')).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByText('Loading incidents…')).toBeDefined();
  });

  test('supports compact row and inline placeholders without exposing visual blocks', () => {
    const { container } = render(
      <>
        <SkeletonRows label="Loading checks…" rows={3} />
        <InlineLoadingSkeleton label="Loading Slack link…" />
      </>,
    );

    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(screen.getByText('Loading checks…')).toBeDefined();
    expect(screen.getByText('Loading Slack link…')).toBeDefined();
    expect(container.querySelectorAll('.sre-skeleton').length).toBeGreaterThan(3);
    expect(container.querySelectorAll('.sre-skeleton[aria-hidden="true"]').length).toBe(
      container.querySelectorAll('.sre-skeleton').length,
    );
  });

  test('restores the complete application shell without nested live regions', () => {
    const { container } = render(<ApplicationLoadingSkeleton />);

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toMatch(/restoring your session/i);
    expect(container.querySelector('aside')).not.toBeNull();
    expect(container.querySelector('main')).not.toBeNull();
  });
});
