// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { installDialogMethods } from '../../test/dialog';
import { KubernetesConnectWizard } from '../KubernetesConnectWizard';
import { saveKubernetesConnector } from '../../lib/useConnectors';

let dialog: ReturnType<typeof installDialogMethods>;
beforeEach(() => {
  dialog = installDialogMethods();
});
afterEach(() => {
  cleanup();
  dialog.restore();
  vi.unstubAllGlobals();
});
function mount(overrides: Partial<ComponentProps<typeof KubernetesConnectWizard>> = {}) {
  const props = {
    mode: 'connect' as const,
    onFetchManifest: vi.fn(async () => 'apiVersion: v1\nkind: Namespace'),
    onSave: vi.fn(async () => ({ connectorId: 'saved-cluster' })),
    onRunTest: vi.fn(async () => ({
      status: 'healthy' as const,
      reachable: true,
      authorized: true,
      checks: { canListPods: true, secretsDenied: true },
      warnings: [],
      enabled: true,
    })),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<KubernetesConnectWizard {...props} />);
  if (!overrides.initialSettings?.apiUrl)
    fireEvent.change(screen.getByLabelText('API server URL'), {
      target: { value: 'https://cluster.example.test' },
    });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  return props;
}
const next = () => fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
const review = () => fireEvent.click(screen.getByRole('button', { name: 'Review' }));
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));

test('a duplicate name can be corrected without losing the token or creating an extra draft', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({ error: 'a data source with this name already exists' }, { status: 409 }),
    )
    .mockResolvedValueOnce(Response.json({ connectorId: 'saved-cluster' }));
  vi.stubGlobal('fetch', fetch);
  const props = mount({
    onSave: (body) =>
      saveKubernetesConnector('https://api.example.test', async () => ({ kind: 'cookie' }), body),
  });
  next();
  fireEvent.change(screen.getByLabelText(/Service account token/i), {
    target: { value: 'test-reader-token' },
  });
  review();
  save();
  await screen.findByText(/A data source with this name already exists/);
  expect(props.onRunTest).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Edit data source name' }));
  fireEvent.change(screen.getByLabelText(/Data source name/), { target: { value: 'Cluster two' } });
  next();
  next();
  expect(screen.getByLabelText(/Service account token/i)).toHaveProperty(
    'value',
    'test-reader-token',
  );
  review();
  save();
  await screen.findByRole('button', { name: 'Finish' });
  expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toMatchObject({
    name: 'Cluster two',
    credential: 'test-reader-token',
  });
  expect(props.onRunTest).toHaveBeenCalledTimes(1);
});

test('existing access skips installation and saves the supplied token before verification', async () => {
  const props = mount();
  expect(screen.getByRole('radio', { name: /Use existing access/ })).toHaveProperty(
    'checked',
    true,
  );
  expect(props.onFetchManifest).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Copy uninstall command' })).toBeNull();
  next();
  expect(screen.queryByRole('button', { name: 'Copy token command' })).toBeNull();
  review();
  expect(screen.getByRole('alert').textContent).toContain('Paste the service account token');
  fireEvent.change(screen.getByLabelText(/Service account token/i), {
    target: { value: 'existing-reader-token' },
  });
  review();
  expect(screen.getByText('Existing service account and RBAC')).toBeDefined();
  save();
  await screen.findByRole('button', { name: 'Finish' });
  expect(props.onSave).toHaveBeenCalledWith(
    expect.objectContaining({ enabled: false, credential: 'existing-reader-token' }),
  );
  expect(props.onRunTest).toHaveBeenCalledWith('saved-cluster');
  expect(props.onFetchManifest).not.toHaveBeenCalled();
});

test('editing keeps the stored token and CA without reinstalling or resubmitting secrets', async () => {
  const props = mount({
    mode: 'edit',
    connectorId: 'saved-cluster',
    credentialConfigured: true,
    initialSettings: { apiUrl: 'https://cluster.example.test', caConfigured: true },
  });
  next();
  review();
  save();
  await screen.findByRole('button', { name: 'Finish' });
  const body = vi.mocked(props.onSave).mock.calls[0]![0];
  expect(body.id).toBe('saved-cluster');
  expect(body).not.toHaveProperty('credential');
  expect(body.settings).not.toHaveProperty('caCert');
  expect(props.onFetchManifest).not.toHaveBeenCalled();
});

test('a failed manifest request does not trap users who already have access', async () => {
  const props = mount({
    onFetchManifest: vi.fn(async () => {
      throw new Error('offline');
    }),
  });
  fireEvent.click(screen.getByRole('radio', { name: /Create dedicated access/ }));
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('radio', { name: /Use existing access/ }));
  next();
  expect(screen.getByLabelText(/Service account token/i)).toBeDefined();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(props.onSave).not.toHaveBeenCalled();
});

test('changing API servers clears a pasted token and cannot reuse the stored credential', () => {
  mount({
    mode: 'edit',
    credentialConfigured: true,
    initialSettings: { apiUrl: 'https://old.example.test' },
  });
  next();
  fireEvent.change(screen.getByLabelText(/Service account token/i), {
    target: { value: 'old-token' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  fireEvent.change(screen.getByLabelText('API server URL'), {
    target: { value: 'https://new.example.test' },
  });
  next();
  next();
  expect(screen.getByLabelText(/Service account token/i)).toHaveProperty('value', '');
  review();
  expect(screen.getByRole('alert').textContent).toContain('Paste a token from the new cluster');
});

test('dedicated installation requires its token even when editing a saved connection', async () => {
  mount({
    mode: 'edit',
    credentialConfigured: true,
    initialSettings: { apiUrl: 'https://cluster.example.test' },
  });
  fireEvent.click(screen.getByRole('radio', { name: /Create dedicated access/ }));
  await screen.findByRole('button', { name: 'Copy install command' });
  next();
  review();
  expect(screen.getByRole('alert').textContent).toContain('Paste the service account token');
});

test('verification retry updates the saved draft instead of creating another connection', async () => {
  const onRunTest = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
    status: 'healthy',
    reachable: true,
    authorized: true,
    warnings: [],
    enabled: true,
  });
  const props = mount({ onRunTest });
  next();
  fireEvent.change(screen.getByLabelText(/Service account token/i), {
    target: { value: 'reader-token' },
  });
  review();
  save();
  await screen.findByRole('alert');
  save();
  await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(2));
  expect(vi.mocked(props.onSave).mock.calls[1]![0].id).toBe('saved-cluster');
});
