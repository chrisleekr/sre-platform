// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { installDialogMethods } from '../../test/dialog';
import { ArgoCdConnectWizard } from '../ArgoCdConnectWizard';

let dialog: ReturnType<typeof installDialogMethods>;
beforeEach(() => {
  dialog = installDialogMethods();
});
afterEach(() => {
  cleanup();
  dialog.restore();
});

const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

function setup(mode: 'connect' | 'edit' = 'connect') {
  const onSave = vi.fn(async () => ({ connectorId: 'saved' }));
  const onRunTest = vi.fn(async () => ({
    status: 'healthy' as const,
    reachable: true,
    authorized: true,
    warnings: [],
    enabled: true,
  }));
  render(
    <ArgoCdConnectWizard
      mode={mode}
      connectorId={mode === 'edit' ? 'saved' : undefined}
      initialSettings={{
        baseUrl: 'https://argo.example',
        accessRole: 'reader',
        projects: [
          {
            project: 'default',
            applications: [{ name: '*' }],
            credentialConfigured: mode === 'edit',
          },
        ],
      }}
      onSave={onSave}
      onRunTest={onRunTest}
      onGenerateAccess={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return { onSave, onRunTest };
}

test.each([
  'bad URL',
  'ftp://argo.example',
  'https://user:secret@argo.example',
  'https://argo.example?token=secret',
])('keeps an invalid URL on Server with an accessible error: %s', (url) => {
  const { onSave, onRunTest } = setup();
  fill('Argo CD server URL', url);
  click('Continue');
  const input = screen.getByLabelText('Argo CD server URL');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(input.getAttribute('aria-describedby')).toContain('argocd-url-error');
  expect(screen.getByRole('alert').textContent).not.toContain('secret');
  expect(onSave).not.toHaveBeenCalled();
  expect(onRunTest).not.toHaveBeenCalled();
  fill('Argo CD server URL', 'https://argo.example');
  click('Continue');
  expect(screen.getByLabelText('Argo CD project 1')).toBeDefined();
});

test.each(['connect', 'edit'] as const)(
  'requires HTTP acknowledgement and saves/verifies the %s draft',
  async (mode) => {
    const { onSave, onRunTest } = setup(mode);
    fill('Argo CD server URL', 'http://argocd-server.argocd.svc.cluster.local');
    expect(screen.queryByRole('group', { name: 'Server certificate trust' })).toBeNull();
    click('Continue');
    expect(screen.getByRole('alert').textContent).toMatch(/Acknowledge.*HTTP/);
    fireEvent.click(screen.getByRole('checkbox', { name: /HTTP sends project tokens/ }));
    click('Continue');
    click('Continue');
    fill('Argo CD token for default', 'replacement-token');
    click('Review');
    expect(screen.getByText('HTTP, unencrypted internal network')).toBeDefined();
    click('Save and verify all projects');
    await screen.findByRole('button', { name: 'Finish' });
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        insecureHttpAcknowledged: true,
        settings: expect.objectContaining({
          baseUrl: 'http://argocd-server.argocd.svc.cluster.local',
        }),
      }),
    );
    expect(onRunTest).toHaveBeenCalledWith('saved');
  },
);

test('changing the endpoint resets HTTP acknowledgement and restores HTTPS controls', () => {
  setup();
  fill('Argo CD server URL', 'http://internal.example');
  fireEvent.click(screen.getByRole('checkbox', { name: /HTTP sends project tokens/ }));
  fill('Argo CD server URL', 'http://other.internal.example');
  expect(
    (screen.getByRole('checkbox', { name: /HTTP sends project tokens/ }) as HTMLInputElement)
      .checked,
  ).toBe(false);
  fill('Argo CD server URL', 'https://argo.example');
  expect(screen.queryByRole('checkbox', { name: /HTTP sends project tokens/ })).toBeNull();
  expect(screen.getByRole('group', { name: 'Server certificate trust' })).toBeDefined();
});
