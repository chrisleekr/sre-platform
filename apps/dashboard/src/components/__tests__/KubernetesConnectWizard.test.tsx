// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { KubernetesConnectWizard } from '../KubernetesConnectWizard';
import type { KubernetesTestResult } from '../../lib/connectors';
import { installDialogMethods } from '../../test/dialog';

let dialogMethods: ReturnType<typeof installDialogMethods>;
let originalClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  dialogMethods = installDialogMethods();
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
});

afterEach(() => {
  cleanup();
  dialogMethods.restore();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks();
});

const PASS: KubernetesTestResult = {
  status: 'healthy',
  reachable: true,
  authorized: true,
  checks: { canListPods: true, secretsDenied: true },
  warnings: [],
  enabled: true,
};

function renderWizard(over?: {
  mode?: 'connect' | 'edit';
  initialSettings?: {
    name?: string;
    apiUrl?: string;
    namespace?: string;
    caConfigured?: boolean;
  };
  credentialConfigured?: boolean;
  onFetchManifest?: (args: { namespace: string; serviceAccount: string }) => Promise<string>;
  onSave?: () => Promise<{ connectorId: string }>;
  onRunTest?: () => Promise<KubernetesTestResult>;
  onClose?: () => void;
}) {
  const onFetchManifest =
    over?.onFetchManifest ?? vi.fn(async () => 'apiVersion: v1\nkind: Namespace');
  const onSave =
    over?.onSave ?? vi.fn(async () => ({ connectorId: '00000000-0000-4000-8000-000000000001' }));
  const onRunTest = over?.onRunTest ?? vi.fn(async () => PASS);
  const onClose = over?.onClose ?? vi.fn();
  render(
    <KubernetesConnectWizard
      mode={over?.mode ?? 'connect'}
      initialSettings={over?.initialSettings}
      credentialConfigured={over?.credentialConfigured}
      onFetchManifest={onFetchManifest}
      onSave={onSave}
      onRunTest={onRunTest}
      onClose={onClose}
    />,
  );
  return { onFetchManifest, onSave, onRunTest, onClose };
}

/** Drive from step 1 through to the test result, filling the minimum required inputs. */
async function driveToResult(apiUrl = 'https://k8s.example.com') {
  fireEvent.change(screen.getByLabelText(/api server url/i), { target: { value: apiUrl } });
  fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // -> step 2 (manifest)
  fireEvent.click(screen.getByRole('radio', { name: /Create dedicated access/ }));
  await screen.findByText(/kubectl apply -f -/i);
  fireEvent.click(screen.getByRole('button', { name: /^continue$/i })); // -> step 3 (paste)
  fireEvent.change(screen.getByLabelText(/service account token/i), {
    target: { value: 'tok-abc' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^review$/i })); // -> step 4 (save + test)
  fireEvent.click(screen.getByRole('button', { name: /save and verify/i }));
}

/** Drive to a pre-save step. Step 4 is the review immediately before the mutating action. */
async function driveToStep(step: 1 | 2 | 3 | 4) {
  if (step === 1) return;
  fireEvent.change(screen.getByLabelText(/api server url/i), {
    target: { value: 'https://k8s.example.com' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
  fireEvent.click(screen.getByRole('radio', { name: /Create dedicated access/ }));
  await screen.findByText(/kubectl apply -f -/i);
  if (step === 2) return;
  fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
  if (step === 3) return;
  fireEvent.change(screen.getByLabelText(/service account token/i), {
    target: { value: 'tok-abc' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^review$/i }));
}

describe('KubernetesConnectWizard', () => {
  test('reopens the same full setup layout with saved values and write-only credentials', async () => {
    const onFetchManifest = vi.fn(async () => 'apiVersion: v1\nkind: Namespace');
    const onSave = vi.fn(async () => ({
      connectorId: '00000000-0000-4000-8000-000000000001',
    }));
    const onRunTest = vi.fn(async () => PASS);
    const onClose = vi.fn();
    renderWizard({
      mode: 'edit',
      initialSettings: {
        name: 'homelab-v2',
        apiUrl: 'https://k8s.example.com',
        namespace: 'platform',
        caConfigured: true,
      },
      credentialConfigured: true,
      onFetchManifest,
      onSave,
      onRunTest,
      onClose,
    });

    const dialog = screen.getByRole('dialog', { name: 'Manage Kubernetes' });
    expect(within(dialog).getByRole('list', { name: 'Setup progress' })).toBeDefined();
    expect(within(dialog).getByLabelText(/cluster name/i)).toHaveProperty('value', 'homelab-v2');
    expect(within(dialog).getByLabelText(/api server url/i)).toHaveProperty(
      'value',
      'https://k8s.example.com',
    );
    expect(within(dialog).getByText(/stored PEM is never prefilled/i)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).getByRole('radio', { name: /Use existing access/ })).toHaveProperty(
      'checked',
      true,
    );
    expect(within(dialog).queryByText(/kubectl apply -f -/i)).toBeNull();
    expect(onFetchManifest).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).getByLabelText(/service account token/i)).toHaveProperty('value', '');
    expect(within(dialog).getByLabelText(/CA certificate/i)).toHaveProperty('value', '');
    expect(within(dialog).getByText(/Leave blank to keep the stored token/i)).toBeDefined();
    expect(within(dialog).getByText(/Leave blank to keep the stored CA/i)).toBeDefined();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(onRunTest).not.toHaveBeenCalled();
  });

  test('opens in a named native setup dialog with named progress steps', async () => {
    renderWizard();

    const dialog = screen.getByRole('dialog', { name: 'Connect Kubernetes' });
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialogMethods.showModal).toHaveBeenCalledTimes(1);
    const progress = within(dialog).getByRole('list', { name: 'Setup progress' });
    for (const name of ['Cluster', 'Access', 'Credentials', 'Review', 'Verify']) {
      expect(within(progress).getByText(name)).toBeDefined();
    }
    expect(within(progress).getByText('Cluster').parentElement?.getAttribute('aria-current')).toBe(
      'step',
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole('heading', { name: 'Connect Kubernetes' }),
      ),
    );
  });

  test('renders step 1 with the cluster/apiUrl/namespace inputs', () => {
    renderWizard();
    expect(screen.getByLabelText(/cluster name/i)).toBeDefined();
    expect(screen.getByLabelText(/api server url/i)).toBeDefined();
    expect(screen.getByLabelText(/namespace/i)).toBeDefined();
    expect(screen.getByText(/leave blank to monitor all namespaces/i)).toBeDefined();
  });

  test('a private apiUrl with system trust is rejected before access installation', () => {
    renderWizard();
    fireEvent.change(screen.getByLabelText(/api server url/i), {
      target: { value: 'https://10.0.0.1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert').textContent).toMatch(/private.*requires a pinned CA/i);
  });

  test('a public apiUrl shows no CA-required hint', () => {
    renderWizard();
    fireEvent.change(screen.getByLabelText(/api server url/i), {
      target: { value: 'https://api.k8s.example.com' },
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  // An in-cluster name always resolves into private space, so system trust cannot verify it. Left
  // unrecognised, the wizard accepts it and verification fails later on the certificate instead.
  test.each([
    'https://kubernetes.default.svc',
    'https://kubernetes.default.svc.cluster.local',
    'https://kubernetes.default',
    'https://kubernetes',
  ])('an in-cluster apiUrl (%s) with system trust is rejected', (apiUrl) => {
    renderWizard();
    fireEvent.change(screen.getByLabelText(/api server url/i), { target: { value: apiUrl } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert').textContent).toMatch(/private.*requires a pinned CA/i);
  });

  test('the save->test flow calls onSave (enabled:false) then onRunTest, in order', async () => {
    const order: string[] = [];
    const onSave = vi.fn(async () => {
      order.push('save');
      return { connectorId: '00000000-0000-4000-8000-000000000001' };
    });
    const onRunTest = vi.fn(async () => {
      order.push('test');
      return PASS;
    });
    renderWizard({ onSave, onRunTest });
    await driveToResult();
    await waitFor(() => expect(onRunTest).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledTimes(1);
    // onSave is typed no-arg for the render prop; read the recorded body positionally.
    expect((onSave.mock.calls as unknown[][])[0]?.[0]).toMatchObject({
      enabled: false,
      credential: 'tok-abc',
      settings: { caCert: '', insecureSkipTLSVerify: false },
    });
    expect(order).toEqual(['save', 'test']);
  });

  test('does not run the test when saving rejects', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('save failed');
    });
    const onRunTest = vi.fn(async () => PASS);
    renderWizard({ onSave, onRunTest });

    await driveToResult();

    await waitFor(() =>
      expect(screen.getByText(/disabled draft may already exist/i)).toBeDefined(),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onRunTest).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  test('warns that configuration may be saved and offers Close when testing rejects', async () => {
    const onSave = vi.fn(async () => ({
      connectorId: '00000000-0000-4000-8000-000000000001',
    }));
    const onRunTest = vi.fn(async () => {
      throw new Error('test failed');
    });
    renderWizard({ onSave, onRunTest });

    await driveToResult();

    await waitFor(() =>
      expect(screen.getByText(/disabled draft may already exist/i)).toBeDefined(),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onRunTest).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Close' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  test.each([1, 2, 3, 4] as const)(
    'step %i always offers Cancel and abandoning before Save and test persists nothing',
    async (step) => {
      const onSave = vi.fn(async () => ({
        connectorId: '00000000-0000-4000-8000-000000000001',
      }));
      const onRunTest = vi.fn(async () => PASS);
      const onClose = vi.fn();
      const { onFetchManifest } = renderWizard({ onSave, onRunTest, onClose });
      await driveToStep(step);

      const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
      expect(cancel.disabled).toBe(false);
      fireEvent.click(cancel);

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onSave).not.toHaveBeenCalled();
      expect(onRunTest).not.toHaveBeenCalled();
      expect(onFetchManifest).toHaveBeenCalledTimes(step >= 2 ? 1 : 0);
    },
  );

  test('fetches a source-specific least-privilege manifest identity when entering Access', async () => {
    const { onFetchManifest } = renderWizard();

    await driveToStep(2);

    expect(onFetchManifest).toHaveBeenCalledWith({
      namespace: expect.stringMatching(/^sre-triage-[0-9a-f]{8}$/),
      serviceAccount: expect.stringMatching(/^sre-triage-reader-[0-9a-f]{8}$/),
    });
  });

  test('announces and skeletons the install command while the manifest is pending', async () => {
    let resolveManifest!: (manifest: string) => void;
    const onFetchManifest = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveManifest = resolve;
        }),
    );
    renderWizard({ onFetchManifest });

    fireEvent.change(screen.getByLabelText(/api server url/i), {
      target: { value: 'https://k8s.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    fireEvent.click(screen.getByRole('radio', { name: /Create dedicated access/ }));
    const status = await screen.findByRole('status');
    expect(status.textContent).toMatch(/loading install command/i);
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.querySelectorAll('.sre-skeleton')).toHaveLength(4);
    for (const block of status.querySelectorAll('.sre-skeleton')) {
      expect(block.getAttribute('aria-hidden')).toBe('true');
    }

    resolveManifest('apiVersion: v1\nkind: Namespace');
    expect(await screen.findByText(/kubectl apply -f -/i)).toBeDefined();
  });

  test('recovers a failed manifest request through the visible Retry action', async () => {
    const onFetchManifest = vi
      .fn()
      .mockRejectedValueOnce(new Error('manifest unavailable'))
      .mockResolvedValueOnce('apiVersion: v1\nkind: Namespace');
    renderWizard({ onFetchManifest });

    fireEvent.change(screen.getByLabelText(/api server url/i), {
      target: { value: 'https://k8s.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /Create dedicated access/ }));
    expect(await screen.findByText(/failed to load the RBAC install command/i)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect((await screen.findAllByText(/kind: Namespace/i)).length).toBe(2);
    expect(screen.queryByText(/failed to load the RBAC install command/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy install command' })).toBeDefined();
    expect(onFetchManifest).toHaveBeenCalledTimes(2);
  });

  test('switches to Close and guards it and native Escape while Save and test is in flight', async () => {
    let resolveSave!: (value: { connectorId: string }) => void;
    const onSave = vi.fn(
      () =>
        new Promise<{ connectorId: string }>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const onRunTest = vi.fn(async () => PASS);
    const onClose = vi.fn();
    renderWizard({ onSave, onRunTest, onClose });
    await driveToStep(4);

    fireEvent.click(screen.getByRole('button', { name: /save and verify/i }));
    const close = screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    const event = new Event('cancel', { cancelable: true });
    fireEvent(screen.getByRole('dialog', { name: 'Connect Kubernetes' }), event);

    expect(event.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(onRunTest).not.toHaveBeenCalled();
    resolveSave({ connectorId: '00000000-0000-4000-8000-000000000001' });
    await waitFor(() => expect(onRunTest).toHaveBeenCalledTimes(1));
  });

  test('the Finish (enable) affordance stays disabled until a passing test result', async () => {
    const failing: KubernetesTestResult = {
      status: 'unhealthy',
      reachable: true,
      authorized: true,
      checks: { canListPods: false, secretsDenied: true },
      warnings: ['token lacks pod read; apply RBAC manifest'],
      enabled: false,
    };
    renderWizard({ onRunTest: vi.fn(async () => failing) });
    await driveToResult();
    const finish = await screen.findByRole('button', { name: /finish/i });
    // status !== 'healthy' -> not a pass -> Finish disabled.
    expect((finish as HTMLButtonElement).disabled).toBe(true);
  });

  test('a failed test still offers enabled Back and Close controls (no trap)', async () => {
    const failing: KubernetesTestResult = {
      status: 'unhealthy',
      reachable: true,
      authorized: true,
      checks: { canListPods: false, secretsDenied: true },
      warnings: ['token lacks pod read; apply RBAC manifest'],
      enabled: false,
    };
    renderWizard({ onRunTest: vi.fn(async () => failing) });
    await driveToResult();
    await screen.findByRole('button', { name: /finish/i });
    // Finish is gated, but Back and Close give the user a way out without a token-losing reload.
    const back = screen.getByRole('button', { name: /^back$/i });
    const close = screen.getByRole('button', { name: /^close$/i });
    expect((back as HTMLButtonElement).disabled).toBe(false);
    expect((close as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(back);

    expect(screen.getByText('Review').parentElement?.getAttribute('aria-current')).toBe('step');
    expect(screen.getByRole('button', { name: 'Close' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  test('a passing test enables the Finish affordance and shows the Enabled badge', async () => {
    renderWizard();
    await driveToResult();
    const finish = await screen.findByRole('button', { name: /finish/i });
    expect((finish as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/enabled/i)).toBeDefined();
  });

  test('a secretsDenied:false result renders the RBAC least-privilege warning', async () => {
    const overPrivileged: KubernetesTestResult = {
      status: 'healthy',
      reachable: true,
      authorized: true,
      checks: { canListPods: true, secretsDenied: false },
      warnings: ['RBAC allows secret reads; apply least-privilege manifest'],
      enabled: true,
    };
    renderWizard({ onRunTest: vi.fn(async () => overPrivileged) });
    await driveToResult();
    await screen.findByRole('button', { name: /finish/i });
    expect(screen.getByText(/RBAC allows secret reads/)).toBeDefined();
  });

  test('exposes copy buttons for the apply and uninstall commands', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const { onFetchManifest } = renderWizard();
    fireEvent.change(screen.getByLabelText(/api server url/i), {
      target: { value: 'https://k8s.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /Create dedicated access/ }));
    await screen.findByText(/kubectl apply -f -/i);
    const access = vi.mocked(onFetchManifest).mock.calls[0]![0];
    fireEvent.click(screen.getByRole('button', { name: 'Copy install command' }));
    expect(writeText.mock.calls.at(-1)?.[0]).toContain(
      "kubectl apply -f - <<'SRE_PLATFORM_KUBERNETES_RBAC'",
    );
    expect(writeText.mock.calls.at(-1)?.[0]).toContain('kind: Namespace');
    fireEvent.click(screen.getByText('Remove cluster access'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy uninstall command' }));
    expect(writeText.mock.calls.at(-1)?.[0]).toContain(
      "kubectl delete -f - <<'SRE_PLATFORM_KUBERNETES_RBAC'",
    );
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy token command' }));
    expect(writeText).toHaveBeenLastCalledWith(
      `kubectl -n ${access.namespace} get secret ${access.serviceAccount}-token -o jsonpath='{.data.token}' | base64 -d`,
    );
    fireEvent.change(screen.getByLabelText(/service account token/i), {
      target: { value: 'tok-abc' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^review$/i }));
    fireEvent.click(screen.getByRole('button', { name: /save and verify/i }));
    await screen.findByRole('button', { name: /finish/i });
  });

  test('applies compact-width classes to long manifests, commands, fields, and actions', async () => {
    renderWizard({
      onFetchManifest: vi.fn(async () => `apiVersion: v1\n${'x'.repeat(500)}`),
    });
    await driveToStep(2);
    const dialog = screen.getByRole('dialog', { name: 'Connect Kubernetes' });
    const manifest = dialog.querySelector('pre');
    const apply = manifest;

    expect(dialog.className).toMatch(/max-w-/);
    expect(manifest?.className).toMatch(/overflow-auto/);
    expect(apply?.className).toMatch(/min-w-0/);
    expect(apply?.className).toMatch(/overflow-auto/);
    expect(apply?.parentElement?.className).toMatch(/min-w-0/);

    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    for (const input of screen.getAllByRole('textbox')) {
      expect(input.className).toMatch(/w-full/);
    }
    expect(screen.getByRole('button', { name: 'Cancel' }).parentElement?.className).toMatch(
      /flex-wrap/,
    );
  });

  test('unmounting and reopening discards every local draft and restarts at Cluster', async () => {
    const props = {
      onFetchManifest: vi.fn(async () => 'apiVersion: v1'),
      onSave: vi.fn(async () => ({
        connectorId: '00000000-0000-4000-8000-000000000001',
      })),
      onRunTest: vi.fn(async () => PASS),
      onClose: vi.fn(),
    };
    const first = render(<KubernetesConnectWizard mode="connect" {...props} />);
    fireEvent.change(screen.getByLabelText(/cluster name/i), { target: { value: 'private-name' } });
    fireEvent.change(screen.getByLabelText(/api server url/i), {
      target: { value: 'https://private.example.com' },
    });
    first.unmount();

    render(<KubernetesConnectWizard mode="connect" {...props} />);

    expect((screen.getByLabelText(/cluster name/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/api server url/i) as HTMLInputElement).value).toBe('');
    expect(screen.getByText('Cluster').parentElement?.getAttribute('aria-current')).toBe('step');
    expect(screen.queryByLabelText(/service account token/i)).toBeNull();
  });
});
