// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

interface SettingFixture {
  key: string;
  value: number;
  defaultValue: number;
}

const h = vi.hoisted(() => ({
  settings: [] as SettingFixture[],
  loading: false,
  error: false,
  errorStatus: null as number | null,
  refetch: vi.fn(),
  save: vi.fn(async (..._args: unknown[]) => ({ key: '', value: 0 })),
  llmRefetch: vi.fn(),
  llmSettings: null as null | {
    config: {
      runtime: 'claude-agent-sdk';
      provider: 'anthropic';
      model: string;
      baseUrl: null;
      authMode: 'api-key';
      maxTurns: number;
      pricing: null | {
        inputPerMTok: number;
        outputPerMTok: number;
        cacheReadPerMTok: number;
        cacheWritePerMTok: number;
      };
    };
    source: 'stored';
    credentialConfigured: boolean;
    updatedAt: string;
  },
  saveLlm: vi.fn(async (..._args: unknown[]) => undefined),
}));

// The shared auth boundary is a hard dependency of the panel; stub it so the hook wiring doesn't run.
vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }) }),
}));
vi.mock('../../lib/usePlatformSettings', () => ({
  usePlatformSettings: () => ({
    settings: h.settings,
    loading: h.loading,
    error: h.error,
    errorStatus: h.errorStatus,
    refetch: h.refetch,
  }),
  savePlatformSetting: (...args: unknown[]) => h.save(...args),
}));
vi.mock('../../lib/useLlmSettings', () => ({
  useLlmSettings: () => ({
    settings: h.llmSettings,
    loading: false,
    error: false,
    errorStatus: null,
    refetch: h.llmRefetch,
  }),
  saveLlmSettings: (...args: unknown[]) => h.saveLlm(...args),
}));
vi.mock('../SmtpSettingsCard', () => ({
  SmtpSettingsCard: () => <section aria-label="SMTP settings" />,
}));

import { SettingsPanel } from '../SettingsPanel';

const setting = (key: string, value: number, defaultValue: number): SettingFixture => ({
  key,
  value,
  defaultValue,
});

afterEach(() => {
  cleanup();
  h.settings = [];
  h.loading = false;
  h.error = false;
  h.errorStatus = null;
  h.refetch.mockReset();
  h.save.mockReset();
  h.llmRefetch.mockReset();
  h.llmSettings = null;
  h.saveLlm.mockReset();
  h.saveLlm.mockResolvedValue(undefined);
  h.save.mockResolvedValue({ key: '', value: 0 });
});

describe('SettingsPanel', () => {
  test('uses one page heading and a reserved, polite first-load state (C1, C7)', () => {
    h.loading = true;
    const { container } = render(<SettingsPanel />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeDefined();
    expect(container.querySelector('[data-page-state="loading"]')?.className).toMatch(/min-h-/);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toMatch(/loading settings/i);
  });

  test('renders arbitrary numeric settings as labelled editors with their defaults', () => {
    h.settings = [setting('sample.rate', 2.5, 1), setting('archive/window', 12, 24)];

    render(<SettingsPanel />);

    for (const item of h.settings) {
      const input = screen.getByLabelText(item.key) as HTMLInputElement;
      expect(input.value).toBe(String(item.value));
      const descriptionId = input.getAttribute('aria-describedby');
      expect(descriptionId).not.toBeNull();
      expect(document.getElementById(descriptionId!)?.textContent).toContain(
        `Default: ${item.defaultValue}`,
      );
      expect(screen.getByRole('button', { name: `Save ${item.key}` })).toBeDefined();
    }
  });

  test('clearing the retention field keeps it editable instead of disabling the policy', async () => {
    const key = 'INCIDENT_AUTO_ARCHIVE_DAYS';
    h.settings = [setting(key, 7, 7)];
    render(<SettingsPanel />);
    const input = screen.getByLabelText(
      'Automatically delete terminal incidents',
    ) as HTMLInputElement;
    const enabled = screen.getByLabelText('Enabled') as HTMLInputElement;

    // Select-all-and-retype: the field is briefly empty. `Number('')` is 0, so deriving the policy
    // state from the raw draft disabled the very input being typed in and unchecked the box under
    // the operator, who then had to re-enable it and lost the edit.
    fireEvent.change(input, { target: { value: '' } });
    expect(input.disabled).toBe(false);
    expect(enabled.checked).toBe(true);
    // Blank is still not saveable. The guard, not the disabled attribute, is what refuses it.
    fireEvent.click(screen.getByRole('button', { name: `Save ${key}` }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/enter a valid number/i);

    // Retyping completes normally, which is the whole point of staying editable.
    fireEvent.change(input, { target: { value: '30' } });
    expect(input.disabled).toBe(false);
    expect(enabled.checked).toBe(true);

    // An explicit 0 still disables: only a BLANK draft is treated as mid-edit.
    fireEvent.change(input, { target: { value: '0' } });
    expect(enabled.checked).toBe(false);
  });

  test('presents automatic deletion as an enabled retention policy and saves zero when disabled', async () => {
    const key = 'INCIDENT_AUTO_ARCHIVE_DAYS';
    h.settings = [setting(key, 7, 7)];
    render(<SettingsPanel />);

    const input = screen.getByLabelText(
      'Automatically delete terminal incidents',
    ) as HTMLInputElement;
    const enabled = screen.getByLabelText('Enabled') as HTMLInputElement;
    expect(enabled.checked).toBe(true);
    expect(input.value).toBe('7');
    expect(screen.getByText(/cannot be undone from the dashboard/i)).toBeDefined();

    fireEvent.click(enabled);
    expect(enabled.checked).toBe(false);
    expect(input.disabled).toBe(true);
    expect(screen.getByText('Automatic incident deletion is disabled.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: `Save ${key}` }));

    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(h.save.mock.calls[0]![2]).toBe(key);
    expect(h.save.mock.calls[0]![3]).toBe(0);
  });

  test('presents and validates the automated recovery cost ceiling', async () => {
    const key = 'RECOVERY_MAX_CHECKS';
    h.settings = [setting(key, 3, 3)];
    render(<SettingsPanel />);

    const input = screen.getByLabelText('Maximum automated recovery checks') as HTMLInputElement;
    expect(input.value).toBe('3');
    expect(input.min).toBe('1');
    expect(input.max).toBe('10');
    expect(screen.getByText(/schedule the next check 1–60 minutes later/i)).toBeDefined();

    fireEvent.change(input, { target: { value: '11' } });
    fireEvent.click(screen.getByRole('button', { name: `Save ${key}` }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/enter a valid number/i);
    expect(h.save).not.toHaveBeenCalled();
  });

  test('presents and validates the evidence character budget', async () => {
    const key = 'EVIDENCE_BUDGET_CHARS';
    h.settings = [setting(key, 24000, 24000)];
    render(<SettingsPanel />);

    const input = screen.getByLabelText(
      'Evidence carried into a continued investigation',
    ) as HTMLInputElement;
    expect(input).toMatchObject({ value: '24000', min: '83', max: '200000', step: '1' });
    // The copy must say this bound decides what the investigator sees. The row ceiling below it
    // only bounds the read, and an operator who confuses the two will tune the wrong one.
    expect(
      screen.getByText(/decides which evidence the investigator actually sees/i),
    ).toBeDefined();

    // 82 is the case that matters: one below a whole rendered block is where every candidate line
    // overflows and the reload returns nothing at all, rather than merely returning less.
    for (const invalid of ['82', '200001', '24000.5']) {
      fireEvent.change(input, { target: { value: invalid } });
      fireEvent.click(screen.getByRole('button', { name: `Save ${key}` }));
      expect((await screen.findByRole('alert')).textContent).toMatch(/enter a valid number/i);
    }
  });

  test('presents and validates the evidence row ceiling', async () => {
    const key = 'EVIDENCE_ROW_LIMIT';
    h.settings = [setting(key, 1000, 1000)];
    render(<SettingsPanel />);

    const input = screen.getByLabelText(
      'Evidence rows loaded per investigation',
    ) as HTMLInputElement;
    expect(input).toMatchObject({ value: '1000', min: '289', max: '10000', step: '1' });
    // The copy has to say the ceiling can hide evidence: an operator lowering it is choosing a
    // bound on what an investigation can read back, not just a performance knob.
    expect(screen.getByText(/can hide older evidence/i)).toBeDefined();

    // Both ends and the integer rule. 288 is the case that matters: one below the floor is where a
    // ceiling starts cutting rows the default character budget could have paid for. The server
    // re-validates, so this guard is a fast rejection rather than the protection, but the widget
    // bounds alone would not catch a pasted or programmatic value.
    for (const invalid of ['288', '10001', '1.5']) {
      fireEvent.change(input, { target: { value: invalid } });
      fireEvent.click(screen.getByRole('button', { name: `Save ${key}` }));
      expect((await screen.findByRole('alert')).textContent).toMatch(/enter a valid number/i);
    }
    expect(h.save).not.toHaveBeenCalled();
  });

  test('presents the token lifetime as a bounded authentication policy', () => {
    const key = 'MAX_TOKEN_LIFETIME_SEC';
    h.settings = [setting(key, 86_400, 86_400)];
    render(<SettingsPanel />);

    const input = screen.getByLabelText('Maximum API bearer-token lifetime') as HTMLInputElement;
    expect(input).toMatchObject({ value: '86400', min: '300', max: '2592000', step: '1' });
    expect(
      screen.getByText(/legacy API bearer tokens and development password tokens/i),
    ).toBeDefined();
    expect(screen.getByText('Default: 86400 seconds')).toBeDefined();
    const section = input.closest('section');
    expect(section?.querySelector('h2')?.textContent).toBe('Authentication');
    expect(screen.queryByRole('heading', { name: 'Queue and automation' })).toBeNull();
  });

  test.each(['299', '300.5', '2592001'])(
    'rejects the invalid token lifetime %s before saving',
    (draft) => {
      const key = 'MAX_TOKEN_LIFETIME_SEC';
      h.settings = [setting(key, 86_400, 86_400)];
      render(<SettingsPanel />);

      fireEvent.change(screen.getByLabelText('Maximum API bearer-token lifetime'), {
        target: { value: draft },
      });
      fireEvent.click(screen.getByRole('button', { name: `Save ${key}` }));

      expect(screen.getByRole('alert').textContent).toMatch(/enter a valid number/i);
      expect(h.save).not.toHaveBeenCalled();
    },
  );

  test('presents zero-unlimited automatic count and configured-cost guards', () => {
    const countKey = 'AUTO_INVESTIGATION_TENANT_LIMIT_24H';
    const costKey = 'AUTO_INVESTIGATION_TENANT_COST_LIMIT_USD_24H';
    h.settings = [setting(countKey, 0, 0), setting(costKey, 2.5, 0)];
    render(<SettingsPanel />);

    const count = screen.getByLabelText('Tenant automatic run limit') as HTMLInputElement;
    const cost = screen.getByLabelText('Tenant configured-cost limit') as HTMLInputElement;
    expect(count).toMatchObject({ value: '0', min: '0', step: '1' });
    expect(cost).toMatchObject({ value: '2.5', min: '0', step: 'any' });
    expect(screen.getAllByText(/zero is unlimited/i)).toHaveLength(2);

    fireEvent.change(count, { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: `Save ${countKey}` }));
    expect(screen.getByRole('alert').textContent).toMatch(/enter a valid number/i);
    expect(h.save).not.toHaveBeenCalled();
  });

  test('can enable automatic deletion when both the saved value and environment default are disabled', () => {
    const key = 'INCIDENT_AUTO_ARCHIVE_DAYS';
    h.settings = [setting(key, 0, 0)];
    render(<SettingsPanel />);

    const enabled = screen.getByLabelText('Enabled') as HTMLInputElement;
    const input = screen.getByLabelText(
      'Automatically delete terminal incidents',
    ) as HTMLInputElement;
    expect(enabled.checked).toBe(false);
    expect(input.disabled).toBe(true);

    fireEvent.click(enabled);

    expect(enabled.checked).toBe(true);
    expect(input.disabled).toBe(false);
    expect(input.value).toBe('7');
  });

  test('shows an honest empty state when the registry has no entries', () => {
    render(<SettingsPanel />);

    expect(screen.getByText(/no platform settings/i)).toBeDefined();
  });

  test('saves a JSON-compatible number once, disables the pending editor, and refetches it', async () => {
    const key = 'sample.rate';
    const otherKey = 'archive/window';
    h.settings = [setting(key, 2.5, 1), setting(otherKey, 12, 24)];
    let finishSave: ((saved: { key: string; value: number }) => void) | undefined;
    h.save.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    const { rerender } = render(<SettingsPanel />);
    const input = screen.getByLabelText(key) as HTMLInputElement;
    const otherInput = screen.getByLabelText(otherKey) as HTMLInputElement;
    const button = screen.getByRole('button', { name: `Save ${key}` }) as HTMLButtonElement;

    fireEvent.change(otherInput, { target: { value: '9.5' } });
    fireEvent.change(input, { target: { value: '3.750' } });
    fireEvent.click(button);

    expect(h.save).toHaveBeenCalledTimes(1);
    const call = h.save.mock.calls[0] as unknown as unknown[];
    expect(call[2]).toBe(key);
    expect(call[3]).toBe(3.75);
    expect(input.disabled).toBe(true);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(h.save).toHaveBeenCalledTimes(1);

    finishSave?.({ key, value: 3.75 });
    await waitFor(() => expect(h.refetch).toHaveBeenCalledTimes(1));
    h.settings = [setting(key, 3.75, 1), setting(otherKey, 12, 24)];
    rerender(<SettingsPanel />);
    expect((screen.getByLabelText(key) as HTMLInputElement).value).toBe('3.75');
    expect((screen.getByLabelText(otherKey) as HTMLInputElement).value).toBe('9.5');
  });

  test.each([
    ['empty', ''],
    ['non-numeric', 'not-a-number'],
  ])('rejects an %s draft without sending a save', (_kind, draft) => {
    const key = 'sample.rate';
    h.settings = [setting(key, 2.5, 1)];
    render(<SettingsPanel />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('');

    const input = screen.getByLabelText(key);
    fireEvent.change(input, { target: { value: draft } });
    fireEvent.click(screen.getByRole('button', { name: `Save ${key}` }));

    expect(alert.textContent ?? '').toMatch(new RegExp(`valid number for ${key}`, 'i'));
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain('platform-settings-alert');
    expect(h.save).not.toHaveBeenCalled();
  });

  test('exposes a failed load as an alert instead of an empty registry', () => {
    h.error = true;

    render(<SettingsPanel />);

    expect(screen.getByRole('alert').textContent ?? '').toMatch(/failed to load/i);
    expect(screen.queryByText(/no platform settings/i)).toBeNull();
  });

  test('explains a 403 as a platform-operator access requirement, not a load failure (C4, C6)', () => {
    h.error = true;
    h.errorStatus = 403;

    render(<SettingsPanel />);

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toMatch(/platform-operator access is required/i);
    expect(screen.getByRole('alert').textContent).not.toMatch(/failed to load/i);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  test('renders the operator denial once inside the pre-mounted atomic alert (C6 regression)', () => {
    h.error = true;
    h.errorStatus = 403;

    render(<SettingsPanel />);

    const message = 'Platform-operator access is required to view platform settings.';
    const matches = screen.getAllByText(message);
    const alert = screen.getByRole('alert');
    expect(matches).toHaveLength(1);
    expect(alert.contains(matches[0]!)).toBe(true);
    expect(alert.getAttribute('aria-atomic')).toBe('true');
  });

  test('keeps non-403 failures generic and offers the existing safe retry (C3, C4, C6)', () => {
    h.error = true;
    h.errorStatus = 500;

    render(<SettingsPanel />);

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toMatch(/failed to load platform settings/i);
    expect(screen.getByRole('alert').textContent).not.toMatch(/platform-operator/i);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  test('keeps a dirty editor visible when a settings refresh fails (C3, C5, C6)', () => {
    const key = 'archive/window';
    h.settings = [setting(key, 12, 24)];
    const { rerender } = render(<SettingsPanel />);

    fireEvent.change(screen.getByLabelText(key), { target: { value: '9.5' } });
    h.error = true;
    h.errorStatus = 500;
    rerender(<SettingsPanel />);

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect((screen.getByLabelText(key) as HTMLInputElement).value).toBe('9.5');
    expect(screen.queryByText(/no platform settings/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  test('keeps the draft and reports an accessible error when a save fails', async () => {
    const key = 'archive/window';
    h.settings = [setting(key, 12, 24)];
    h.save.mockRejectedValue(new Error('request failed'));
    render(<SettingsPanel />);
    const input = screen.getByLabelText(key) as HTMLInputElement;

    fireEvent.change(input, { target: { value: '9.5' } });
    fireEvent.click(screen.getByRole('button', { name: `Save ${key}` }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByRole('alert').textContent ?? '').toMatch(/failed to save/i);
    expect(input.value).toBe('9.5');
    expect(input.disabled).toBe(false);
    expect(h.refetch).not.toHaveBeenCalled();
    expect(screen.queryByText(/saved|updated successfully/i)).toBeNull();
  });

  test('presents investigator runtime, write-only credentials, and custom pricing without usage', async () => {
    h.llmSettings = {
      config: {
        runtime: 'claude-agent-sdk',
        provider: 'anthropic',
        model: 'claude-test',
        baseUrl: null,
        authMode: 'api-key',
        maxTurns: 8,
        pricing: null,
      },
      source: 'stored',
      credentialConfigured: true,
      updatedAt: '2026-08-25T00:00:00.000Z',
    };
    render(<SettingsPanel />);

    expect(screen.getByRole('heading', { name: 'Investigator model' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: /usage and cost/i })).toBeNull();
    expect((screen.getByLabelText(/^Model ID/) as HTMLInputElement).value).toBe('claude-test');
    expect((screen.getByLabelText(/^API key/) as HTMLInputElement).value).toBe('');
    expect(screen.getByText(/write-only and never returned/i)).toBeDefined();

    fireEvent.click(screen.getByLabelText(/use custom pricing/i));
    fireEvent.change(screen.getByLabelText('Input / MTok'), { target: { value: '1.25' } });
    fireEvent.change(screen.getByLabelText('Output / MTok'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save investigator model' }));

    await waitFor(() => expect(h.saveLlm).toHaveBeenCalledTimes(1));
    const body = h.saveLlm.mock.calls[0]![2] as {
      config: { pricing: { inputPerMTok: number; outputPerMTok: number } };
      credential?: string;
    };
    expect(body.config.pricing).toMatchObject({ inputPerMTok: 1.25, outputPerMTok: 5 });
    expect(body).not.toHaveProperty('credential');
  });

  test('rejects custom pricing without positive input and output rates before saving', () => {
    h.llmSettings = {
      config: {
        runtime: 'claude-agent-sdk',
        provider: 'anthropic',
        model: 'claude-test',
        baseUrl: null,
        authMode: 'api-key',
        maxTurns: 8,
        pricing: null,
      },
      source: 'stored',
      credentialConfigured: true,
      updatedAt: '2026-08-25T00:00:00.000Z',
    };
    render(<SettingsPanel />);

    fireEvent.click(screen.getByLabelText(/use custom pricing/i));
    fireEvent.change(screen.getByLabelText('Cache read / MTok'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save investigator model' }));

    expect(screen.getByRole('alert').textContent).toMatch(/positive input and output rates/i);
    expect(h.saveLlm).not.toHaveBeenCalled();
  });

  test('requires a replacement credential when the provider identity changes', () => {
    h.llmSettings = {
      config: {
        runtime: 'claude-agent-sdk',
        provider: 'anthropic',
        model: 'claude-test',
        baseUrl: null,
        authMode: 'api-key',
        maxTurns: 8,
        pricing: null,
      },
      source: 'stored',
      credentialConfigured: true,
      updatedAt: '2026-08-25T00:00:00.000Z',
    };
    render(<SettingsPanel />);

    fireEvent.change(screen.getByLabelText('Provider'), {
      target: { value: 'custom-anthropic' },
    });
    fireEvent.change(screen.getByLabelText('Anthropic-compatible base URL'), {
      target: { value: 'https://llm.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save investigator model' }));

    expect(screen.getByRole('alert').textContent).toMatch(/enter a credential/i);
    expect(h.saveLlm).not.toHaveBeenCalled();
  });
});
