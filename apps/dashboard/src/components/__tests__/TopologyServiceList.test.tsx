// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TopologyServiceList } from '../TopologyServiceList';
import type { GraphNode } from '../../lib/topology';

const node = (over: Partial<GraphNode> & { name: string }): GraphNode => ({
  team: null,
  criticality: null,
  lastDeployAt: null,
  recentDeploys: [],
  ...over,
});

describe('TopologyServiceList', () => {
  test('preserves graph order and shows the current service fields with explicit fallbacks', () => {
    const checkout = node({
      name: 'checkout',
      team: 'payments',
      criticality: 'tier1',
      lastDeployAt: new Date().toISOString(),
      recentDeploys: [
        {
          sha: 'abc1234',
          ref: 'main',
          status: 'success',
          deployedAt: new Date().toISOString(),
        },
      ],
    });
    const orders = node({ name: 'orders' });

    render(<TopologyServiceList nodes={[checkout, orders]} selected={null} onSelect={() => {}} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      expect.stringContaining('checkout'),
      expect.stringContaining('orders'),
    ]);
    for (const value of ['checkout', 'payments', 'tier1', 'Reported deployment · success']) {
      expect(within(buttons[0]!).getByText(value)).toBeDefined();
    }
    for (const fallback of ['No team', 'No criticality', 'No recorded deployment']) {
      expect(within(buttons[1]!).getByText(fallback)).toBeDefined();
    }
  });

  test('uses native pressed buttons and selects the original graph node', () => {
    const checkout = node({ name: 'checkout' });
    const orders = node({ name: 'orders' });
    const onSelect = vi.fn();
    render(
      <TopologyServiceList nodes={[checkout, orders]} selected="orders" onSelect={onSelect} />,
    );

    const checkoutButton = screen.getByRole('button', { name: /checkout/i });
    const ordersButton = screen.getByRole('button', { name: /orders/i });
    expect(checkoutButton.getAttribute('aria-pressed')).toBe('false');
    expect(ordersButton.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(checkoutButton);
    expect(onSelect).toHaveBeenCalledWith(checkout);
  });

  test('wraps long service identity and metadata without a horizontal-scroll duplicate', () => {
    const name = 'checkout-edge-router-with-a-long-uninterrupted-service-identity';
    const { container } = render(
      <TopologyServiceList
        nodes={[node({ name, team: 'platform-observability-with-a-long-team-name' })]}
        selected={null}
        onSelect={() => {}}
      />,
    );

    const button = screen.getByRole('button', { name: new RegExp(name) });
    expect(button.className).toMatch(/min-w-0|w-full/);
    expect(screen.getByText(name).className).toMatch(/break-words|break-all/);
    expect(container.querySelector('.overflow-x-auto')).toBeNull();
  });
});
