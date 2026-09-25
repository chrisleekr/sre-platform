// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { installDialogMethods } from '../../test/dialog';
import { ArgoCdConnectWizard } from '../ArgoCdConnectWizard';
import { ObservabilityConnectWizard } from '../ObservabilityConnectWizard';
import type { ArgoCdAccessResult } from '../../lib/connectors';

let dialog: ReturnType<typeof installDialogMethods>;
beforeEach(() => {
  dialog = installDialogMethods();
});
afterEach(() => {
  cleanup();
  dialog.restore();
});
const healthy = {
  status: 'healthy' as const,
  reachable: true,
  authorized: true,
  warnings: [],
  enabled: true,
};
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

const generatedAccess: ArgoCdAccessResult = {
  instructions: {
    project: 'default',
    role: 'incident-reader',
    identity: 'proj:default:incident-reader',
    policies: ['p, proj:default:incident-reader, applications, get, default/*, allow'],
    tokenCommand: 'argocd proj role create-token default incident-reader',
  },
  commands: {
    createRole: 'create-role-fixture',
    addPolicies: 'add-policies-fixture',
    install: 'create-role-fixture',
    uninstall: 'delete-role-fixture',
  },
};

test.each(['connect', 'edit'] as const)(
  'returns from failed Argo CD verification to edit and retry the same %s draft',
  async (mode) => {
    const onSave = vi.fn(async (_body: unknown) => ({ connectorId: 'argo-saved' }));
    const onClose = vi.fn();
    const onRunTest = vi
      .fn()
      .mockResolvedValueOnce({ ...healthy, status: 'unhealthy', enabled: false })
      .mockResolvedValue(healthy);
    render(
      <ArgoCdConnectWizard
        mode={mode}
        connectorId={mode === 'edit' ? 'argo-saved' : undefined}
        initialSettings={{
          baseUrl: 'https://argo.example.test',
          accessRole: 'incident-reader',
          projects: [
            {
              project: 'default',
              applications: [{ name: '*' }],
              credentialConfigured: mode === 'edit',
            },
          ],
        }}
        onGenerateAccess={vi.fn()}
        onSave={onSave}
        onRunTest={onRunTest}
        onClose={onClose}
      />,
    );
    click('Continue');
    click('Continue');
    if (mode === 'connect') fill('Argo CD token for default', 'project-token');
    click('Review');
    click('Save and verify all projects');
    await screen.findByRole('button', { name: 'Edit configuration' });
    expect(screen.queryByRole('button', { name: 'Finish' })).toBeNull();
    click('Edit configuration');
    expect(screen.getByLabelText('Argo CD project 1')).toHaveProperty('value', 'default');
    click('Back');
    expect(screen.getByLabelText('Argo CD server URL')).toHaveProperty(
      'value',
      'https://argo.example.test',
    );
    click('Continue');
    fill('Optional label selector', 'team=platform');
    click('Continue');
    expect(screen.getByLabelText('Existing project role name')).toHaveProperty('readOnly', true);
    fireEvent.click(screen.getByRole('radio', { name: 'Generate dedicated access' }));
    expect(screen.getByText('incident-reader', { selector: 'strong' })).toBeDefined();
    fireEvent.click(screen.getByRole('radio', { name: 'Use existing project access' }));
    expect(screen.getByLabelText('Argo CD token for default')).toHaveProperty(
      'value',
      mode === 'connect' ? 'project-token' : '',
    );
    click('Review');
    click('Save and verify all projects');
    await screen.findByRole('button', { name: 'Finish' });
    expect(screen.queryByRole('button', { name: 'Edit configuration' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSave.mock.calls[1]![0]).toMatchObject({
      id: 'argo-saved',
      settings: { labelSelector: 'team=platform' },
      credentials: mode === 'connect' ? [{ project: 'default', token: 'project-token' }] : [],
    });
    expect(onRunTest.mock.calls).toEqual([['argo-saved'], ['argo-saved']]);
    click('Finish');
    expect(onClose).toHaveBeenCalledOnce();
  },
);

test('imports an existing Argo CD role without generating commands and reuses its saved draft on retry', async () => {
  const onGenerateAccess = vi.fn();
  const onSave = vi.fn(async (_body: unknown) => ({ connectorId: 'argo-saved' }));
  const onRunTest = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(healthy);
  render(
    <ArgoCdConnectWizard
      mode="connect"
      onGenerateAccess={onGenerateAccess}
      onSave={onSave}
      onRunTest={onRunTest}
      onClose={vi.fn()}
    />,
  );
  click('Continue');
  click('Continue');
  expect(screen.getByRole('radio', { name: 'Use existing project access' })).toHaveProperty(
    'checked',
    true,
  );
  expect(screen.queryByRole('button', { name: 'Generate access commands' })).toBeNull();
  fill('Existing project role name', 'incident-reader');
  fireEvent.click(screen.getByText('How to find the existing role and token for default'));
  expect(screen.getByText("argocd proj role list 'default'")).toBeDefined();
  expect(screen.getByText("argocd proj role get 'default' 'incident-reader'")).toBeDefined();
  fill('Argo CD token for default', 'existing-project-token');
  click('Review');
  click('Save and verify all projects');
  await screen.findByRole('alert');
  click('Save and verify all projects');
  await screen.findByRole('button', { name: 'Finish' });
  expect(onSave.mock.calls[0]![0]).toMatchObject({
    settings: { accessRole: 'incident-reader' },
    credentials: [{ project: 'default', token: 'existing-project-token' }],
  });
  expect(onSave.mock.calls[1]![0]).toMatchObject({ id: 'argo-saved' });
  expect(onGenerateAccess).not.toHaveBeenCalled();
});

test('Argo CD preserves stored project credentials and locks the role on edit', async () => {
  const onSave = vi.fn(async (_body: unknown) => ({ connectorId: 'argo-saved' }));
  const onGenerateAccess = vi.fn(async () => generatedAccess);
  render(
    <ArgoCdConnectWizard
      mode="edit"
      connectorId="argo-saved"
      initialSettings={{
        baseUrl: 'https://argo.example.test',
        accessRole: 'incident-reader',
        projects: [
          { project: 'default', applications: [{ name: '*' }], credentialConfigured: true },
        ],
      }}
      onGenerateAccess={onGenerateAccess}
      onSave={onSave}
      onRunTest={async () => healthy}
      onClose={vi.fn()}
    />,
  );
  click('Continue');
  click('Continue');
  expect(screen.getByLabelText('Existing project role name')).toHaveProperty('readOnly', true);
  expect(screen.queryByText(/uninstall the existing role first/i)).toBeNull();
  expect(onGenerateAccess).not.toHaveBeenCalled();
  const generate = screen.getByRole('radio', { name: 'Generate dedicated access' });
  expect(generate).toHaveProperty('disabled', false);
  fireEvent.click(generate);
  click('Generate access commands');
  await screen.findByText('argocd proj role create-token default incident-reader');
  expect(screen.getByText("argocd proj role list 'default'")).toBeDefined();
  expect(screen.getByText("argocd proj role get 'default' 'incident-reader'")).toBeDefined();
  expect(screen.queryByText(/This role already exists/)).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Copy default create role command' }).closest('details'),
  ).toBeNull();
  expect(screen.getByRole('button', { name: 'Copy default read policies command' })).toBeDefined();
  const savedBadge = screen.getByText('Credential saved');
  expect(savedBadge.className).not.toContain('success');
  expect(screen.getByText(/Saving a credential does not confirm it works/)).toBeDefined();
  expect(screen.getByText(/If GitOps manages this AppProject/)).toBeDefined();
  expect(screen.getByText('Uninstall access later')).toBeDefined();
  expect(screen.getAllByText(/argocd proj role create-token/)).toHaveLength(1);
  expect(screen.getByText('add-policies-fixture')).toBeDefined();
  fireEvent.click(screen.getByRole('radio', { name: 'Use existing project access' }));
  expect(screen.queryByText('Uninstall access later')).toBeNull();
  expect(screen.getAllByText(/argocd proj role create-token/)).toHaveLength(1);
  expect(screen.getByLabelText('Existing project role name')).toHaveProperty(
    'value',
    'incident-reader',
  );
  click('Review');
  click('Save and verify all projects');
  await screen.findByRole('button', { name: 'Finish' });
  expect(onSave.mock.calls[0]![0]).toMatchObject({
    id: 'argo-saved',
    credentials: [],
    settings: { accessRole: 'incident-reader' },
  });
  expect(onGenerateAccess).toHaveBeenCalledWith(
    expect.objectContaining({ project: 'default', role: 'incident-reader' }),
  );
});

test.each(['new project', 'changed server'])(
  'Argo CD keeps optional installation commands available for a %s on edit',
  async (change) => {
    render(
      <ArgoCdConnectWizard
        mode="edit"
        connectorId="argo-saved"
        initialSettings={{
          baseUrl: 'https://argo.example.test',
          accessRole: 'incident-reader',
          projects: [
            { project: 'payments', applications: [{ name: '*' }], credentialConfigured: true },
          ],
        }}
        onGenerateAccess={async () => generatedAccess}
        onSave={vi.fn()}
        onRunTest={async () => healthy}
        onClose={vi.fn()}
      />,
    );
    if (change === 'changed server') fill('Argo CD server URL', 'https://other.example.test');
    click('Continue');
    if (change === 'new project') {
      click('Add project');
      fill('Argo CD project 2', 'default');
    }
    click('Continue');
    fireEvent.click(screen.getByRole('radio', { name: 'Generate dedicated access' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Generate access commands' }).at(-1)!);
    await screen.findByText('create-role-fixture');
    fireEvent.click(screen.getByRole('radio', { name: 'Use existing project access' }));
    expect(screen.getByLabelText('Existing project role name')).toHaveProperty('readOnly', true);
  },
);

test('Argo CD locks access selection and navigation while command generation is pending', async () => {
  let finish!: (value: ArgoCdAccessResult) => void;
  render(
    <ArgoCdConnectWizard
      mode="connect"
      onGenerateAccess={() =>
        new Promise((resolve) => {
          finish = resolve;
        })
      }
      onSave={vi.fn()}
      onRunTest={async () => healthy}
      onClose={vi.fn()}
    />,
  );
  click('Continue');
  click('Continue');
  fireEvent.click(screen.getByRole('radio', { name: 'Generate dedicated access' }));
  click('Generate access commands');
  const reuse = screen.getByRole('radio', { name: 'Use existing project access' });
  expect(reuse).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Back' })).toHaveProperty('disabled', true);
  expect(screen.getByRole('button', { name: 'Review' })).toHaveProperty('disabled', true);
  reuse.click();
  expect(reuse).toHaveProperty('checked', false);
  finish(generatedAccess);
  await screen.findByText('create-role-fixture');
  fireEvent.click(reuse);
  expect(screen.getByLabelText('Existing project role name')).toBeDefined();
  expect(screen.queryByText('create-role-fixture')).toBeNull();
  expect(screen.queryByText('delete-role-fixture')).toBeNull();
});

test.each(['', 'sre-platform', 'Admin'])(
  'rejects invalid or reserved new Argo CD role %j before save',
  (role) => {
    const onSave = vi.fn();
    render(
      <ArgoCdConnectWizard
        mode="connect"
        onGenerateAccess={vi.fn()}
        onSave={onSave}
        onRunTest={async () => healthy}
        onClose={vi.fn()}
      />,
    );
    click('Continue');
    click('Continue');
    fill('Existing project role name', role);
    fill('Argo CD token for default', 'token');
    click('Review');
    expect(screen.getByRole('alert')).toBeDefined();
    expect(onSave).not.toHaveBeenCalled();
  },
);

test.each(['datadog', 'grafana'] as const)(
  '%s keeps existing credentials without asking for replacements',
  async (type) => {
    const onSave = vi.fn(async (_body: unknown) => ({ connectorId: 'saved' }));
    render(
      <ObservabilityConnectWizard
        type={type}
        mode="edit"
        connectorId="saved"
        credentialConfigured
        initialSettings={{ baseUrl: 'https://grafana.example.test' }}
        onSave={onSave}
        onRunTest={async () => healthy}
        onClose={vi.fn()}
      />,
    );
    click('Credentials');
    click('Review');
    click('Save and verify');
    await screen.findByRole('button', { name: 'Finish' });
    expect(onSave.mock.calls[0]![0]).not.toHaveProperty('credential');
  },
);

test('Datadog never silently discards one replacement key while keeping the old pair', () => {
  render(
    <ObservabilityConnectWizard
      type="datadog"
      mode="edit"
      connectorId="saved"
      credentialConfigured
      onSave={vi.fn()}
      onRunTest={async () => healthy}
      onClose={vi.fn()}
    />,
  );
  click('Credentials');
  fill('API key', 'replacement-api-key');
  click('Review');
  expect(screen.getByRole('alert').textContent).toContain('Enter both Datadog keys');
});

test.each(['datadog', 'grafana'] as const)(
  '%s reuses the saved draft when verification fails',
  async (type) => {
    const onSave = vi.fn(async (_body: unknown) => ({ connectorId: 'saved' }));
    const onRunTest = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(healthy);
    render(
      <ObservabilityConnectWizard
        type={type}
        mode="connect"
        initialSettings={{ baseUrl: 'https://grafana.example.test' }}
        onSave={onSave}
        onRunTest={onRunTest}
        onClose={vi.fn()}
      />,
    );
    click('Credentials');
    if (type === 'datadog') {
      fill('API key', 'existing-api');
      fill('Application key', 'existing-app');
    } else fill('Service account token', 'existing-token');
    click('Review');
    click('Save and verify');
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Close' })).toBeDefined();
    click('Save and verify');
    await screen.findByRole('button', { name: 'Finish' });
    expect(onSave.mock.calls[1]![0]).toMatchObject({ id: 'saved' });
  },
);
