// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader } from '../PageHeader';

describe('PageHeader', () => {
  test('renders one page heading and an optional existing action (C7)', () => {
    render(
      <PageHeader title="Connectors" action={<button type="button">Connect Kubernetes</button>} />,
    );

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Connectors' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Connect Kubernetes' })).toBeDefined();
  });

  test('does not invent an action when none is supplied (C7)', () => {
    render(<PageHeader title="Infrastructure" />);

    expect(screen.getByRole('heading', { level: 1, name: 'Infrastructure' })).toBeDefined();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
