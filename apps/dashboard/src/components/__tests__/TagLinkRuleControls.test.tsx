// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { TagLinkRuleControls } from '../TagLinkRuleControls';

describe('TagLinkRuleControls', () => {
  test('saves an explicit tenant prefix template and removes existing rules', async () => {
    const onSave = vi.fn(async () => {});
    const onRemove = vi.fn(async () => {});
    render(
      <TagLinkRuleControls
        rules={[{ prefix: 'bug', urlTemplate: 'https://tracker.example/issues/{value}' }]}
        onSave={onSave}
        onRemove={onRemove}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith('bug'));

    fireEvent.change(screen.getByLabelText('Prefix'), { target: { value: 'customer' } });
    fireEvent.change(screen.getByLabelText('HTTPS URL template'), {
      target: { value: 'https://crm.example/customers/{value}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save link' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        prefix: 'customer',
        urlTemplate: 'https://crm.example/customers/{value}',
      }),
    );
  });
});
