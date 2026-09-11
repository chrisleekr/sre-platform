// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SlackConnectWizard } from '../SlackConnectWizard';
import { RequestError } from '../../lib/request-error';
// The REAL shipped contract, not a local mirror: a hand-written copy drifts from the type the component
// actually consumes, and then enforces nothing about it.
import type { SlackTestResult } from '../../lib/surfaces';
import { installDialogMethods } from '../../test/dialog';

let dialogMethods: ReturnType<typeof installDialogMethods>;

beforeEach(() => {
  dialogMethods = installDialogMethods();
});

afterEach(() => {
  cleanup();
  dialogMethods.restore();
  vi.restoreAllMocks();
});

const PASS: SlackTestResult = { ok: true, botUserId: 'U0BOT', team: 'T0' };

function renderWizard(over?: {
  onSave?: () => Promise<void>;
  onRunTest?: () => Promise<SlackTestResult>;
  onClose?: () => void;
}) {
  const onSave = over?.onSave ?? vi.fn(async () => {});
  const onRunTest = over?.onRunTest ?? vi.fn(async () => PASS);
  const onClose = over?.onClose ?? vi.fn();
  render(<SlackConnectWizard onSave={onSave} onRunTest={onRunTest} onClose={onClose} />);
  return { onSave, onRunTest, onClose };
}

/** Fill the write-only credentials and submit the save-then-verify flow. That is the whole connection:
 * there is no channel to post to and no inbound flag. */
async function driveToResult() {
  fireEvent.change(screen.getByLabelText(/app token/i), {
    target: { value: 'xapp-abc' },
  });
  fireEvent.change(screen.getByLabelText(/bot token/i), {
    target: { value: 'xoxb-abc' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
  fireEvent.click(screen.getByRole('button', { name: /save and verify/i }));
}

describe('SlackConnectWizard', () => {
  test('opens as a named native modal and focuses its title', async () => {
    renderWizard();

    const dialog = screen.getByRole('dialog', { name: 'Connect Slack' });
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialogMethods.showModal).toHaveBeenCalledTimes(1);
    const title = within(dialog).getByRole('heading', { name: 'Connect Slack' });
    await waitFor(() => expect(document.activeElement).toBe(title));
  });

  test('secret inputs start empty (write-only)', () => {
    renderWizard();
    expect((screen.getByLabelText(/app token/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/bot token/i) as HTMLInputElement).value).toBe('');
  });

  test('uses the shared Credentials, Review, Verify flow', () => {
    renderWizard();
    const progress = screen.getByRole('list', { name: 'Setup progress' });
    for (const name of ['Credentials', 'Review', 'Verify']) {
      expect(within(progress).getByText(name)).toBeDefined();
    }
    expect(
      within(progress).getByText('Credentials').closest('li')?.getAttribute('aria-current'),
    ).toBe('step');
  });

  test('requires both correctly typed tokens before reviewing a new connection', () => {
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByText(/both the app token and bot token are required/i)).toBeDefined();
    fireEvent.change(screen.getByLabelText(/app token/i), { target: { value: 'xoxb-wrong' } });
    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: 'xoxb-correct' } });
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByText(/app token must start with xapp-/i)).toBeDefined();
  });

  // the AI answers in the alert's own thread, and subscribing a channel IS the inbound
  // opt-in — so neither a post-to channel nor an inbound toggle belongs in the connect flow.
  test('offers no post-to-channel field and no inbound toggle', () => {
    renderWizard();
    expect(screen.queryByLabelText(/channel to post to/i)).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  test('explains both token sources and the required and optional bot scopes', () => {
    renderWizard();
    const hint = screen.getByText(
      (_content, element) =>
        element?.tagName === 'P' && element.textContent?.includes('OAuth & Permissions'),
    );
    expect(hint.textContent).toMatch(/validation requires users:read/i);
    expect(hint.textContent).toMatch(/users:read\.email.*optional/i);
    expect(screen.getByText('connections:write', { selector: 'code' })).toBeDefined();
  });

  test('saves only the credentials entered (no target, no inbound flag)', async () => {
    const onSave = vi.fn(async () => {});
    renderWizard({ onSave });
    await driveToResult();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const saved = (onSave.mock.calls[0] as unknown as unknown[])[0];
    expect(saved).toEqual({ appToken: 'xapp-abc', botToken: 'xoxb-abc' });
  });

  test('reviews secret handling without rendering either token', () => {
    renderWizard();
    fireEvent.change(screen.getByLabelText(/app token/i), { target: { value: 'xapp-private' } });
    fireEvent.change(screen.getByLabelText(/bot token/i), { target: { value: 'xoxb-private' } });
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));

    expect(screen.getByText('Review').closest('li')?.getAttribute('aria-current')).toBe('step');
    expect(screen.getByText(/stored encrypted and never returned/i)).toBeDefined();
    expect(document.body.textContent).not.toContain('xapp-private');
    expect(document.body.textContent).not.toContain('xoxb-private');
  });

  test('the save->verify flow calls onSave before onRunTest', async () => {
    const onSave = vi.fn(async () => {});
    const onRunTest = vi.fn(async () => PASS);
    renderWizard({ onSave, onRunTest });
    await driveToResult();
    await waitFor(() => expect(onRunTest).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledTimes(1);
    // Save must persist the credential before the test verifies it against Slack. [D2 -> D3]
    expect(Number(onSave.mock.invocationCallOrder[0])).toBeLessThan(
      Number(onRunTest.mock.invocationCallOrder[0]),
    );
  });

  test('Cancel abandons the local credential draft without saving or testing', () => {
    const onSave = vi.fn(async () => {});
    const onRunTest = vi.fn(async () => PASS);
    const onClose = vi.fn();
    renderWizard({ onSave, onRunTest, onClose });
    fireEvent.change(screen.getByLabelText(/app token/i), {
      target: { value: 'xapp-never-save' },
    });
    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: 'xoxb-never-save' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(onRunTest).not.toHaveBeenCalled();
  });

  test('guards Close and native Escape while Save and verify is in flight', async () => {
    let resolveSave!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const onRunTest = vi.fn(async () => PASS);
    const onClose = vi.fn();
    renderWizard({ onSave, onRunTest, onClose });
    await driveToResult();

    const close = screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    const event = new Event('cancel', { cancelable: true });
    fireEvent(screen.getByRole('dialog', { name: 'Connect Slack' }), event);

    expect(event.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(onRunTest).not.toHaveBeenCalled();
    resolveSave();
    await waitFor(() => expect(onRunTest).toHaveBeenCalledTimes(1));
  });

  test('a passing test result displays the resolved bot user id and team', async () => {
    renderWizard();
    await driveToResult();
    await waitFor(() => expect(screen.getByText(/U0BOT/)).toBeDefined());
    expect(screen.getByText(/team T0/i)).toBeDefined();
  });

  test('a failing test result renders the error and still saved first', async () => {
    const onSave = vi.fn(async () => {});
    const onRunTest = vi.fn(async () => ({ ok: false, error: 'invalid_auth' }) as SlackTestResult);
    renderWizard({ onSave, onRunTest });
    await driveToResult();
    await waitFor(() =>
      expect(screen.getByText(/verification failed: invalid_auth/i)).toBeDefined(),
    );
    // The save persisted before the probe failed, so a retry re-tests the stored credential. [D3]
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(Number(onSave.mock.invocationCallOrder[0])).toBeLessThan(
      Number(onRunTest.mock.invocationCallOrder[0]),
    );
  });

  test('shows the specific save failure instead of replacing it with a credential guess', async () => {
    renderWizard({
      onSave: vi.fn(async () => {
        throw new RequestError('Slack workspace is already connected to another tenant', 409);
      }),
    });

    await driveToResult();

    await waitFor(() =>
      expect(screen.getByText(/already connected to another tenant/i)).toBeDefined(),
    );
    expect(screen.queryByText(/check the values and try again/i)).toBeNull();
  });

  // the API probes users.info after auth.test and, on a documented missing_scope, hands back a
  // NON-BLOCKING warning on an otherwise-passing 200. The wizard is a dumb renderer here — it shows
  // whatever the API named, and the fixture's wording below is the API's to choose, not the wizard's.
  //
  // One-directional, deliberately: users:read.email cannot be detected (users.info succeeds without it,
  // merely omitting profile.email), so there is no "scopes OK" to render. A green tick would vouch for
  // half a requirement, which is worse than no check at all. The result stays a PASS: the connection
  // works, and a tenant that does not want attribution is a valid configuration.
  test('scope probe: renders the warning and never claims scopes are OK', async () => {
    const WARNED: SlackTestResult = {
      ok: true,
      botUserId: 'U0BOT',
      team: 'T0',
      // Verbatim from ATTRIBUTION_SCOPE_WARNING in apps/api/src/surface-config.ts. Copied, not imported:
      // the dashboard has no dependency on apps/api, and the wire contract carries this as opaque prose,
      // so a fixture the API never emits would let this pass against wording the product cannot produce.
      warning:
        'Slack rejected users.info with missing_scope, so author attribution is not working: replies ' +
        'and approvals will be recorded with no author. Add the users:read and users:read.email bot ' +
        'scopes to the Slack app, then reinstall it. Add both: Slack requires them together, and this ' +
        'test cannot detect users:read.email on its own — without it users.info still succeeds and ' +
        'simply omits the email.',
    };
    const onRunTest = vi.fn(async () => WARNED);
    renderWizard({ onRunTest });
    await driveToResult();
    // Still a pass — the warning rides ALONGSIDE the connected identity, it does not replace it.
    await waitFor(() => expect(screen.getByText(/U0BOT/)).toBeDefined());
    // A stable substring of the API's REAL sentence, not the scope names: 's static hint renders
    // "users:read" unconditionally, so asserting a scope name would pass with no warning present at all.
    expect(screen.getByText(/Slack rejected users\.info with missing_scope/i)).toBeDefined();
    // Nothing anywhere may affirm the scopes: the probe cannot support such a claim.
    expect(
      screen.queryByText(/scopes?\s+(are\s+)?(ok|okay|fine|verified|granted|good)/i),
    ).toBeNull();
  });

  test('keeps fields, warning text, and actions within the compact dialog structure', () => {
    renderWizard();
    const dialog = screen.getByRole('dialog', { name: 'Connect Slack' });

    expect(dialog.className).toMatch(/max-w-/);
    for (const input of within(dialog).getAllByLabelText(/app token|bot token/i)) {
      expect(input.className).toMatch(/w-full/);
      expect(input.className).toMatch(/min-w-0/);
    }
    expect(
      within(dialog).getByText(
        (_content, element) =>
          element?.tagName === 'P' && element.textContent?.includes('OAuth & Permissions'),
      ).className,
    ).toMatch(/break-words/);
    expect(within(dialog).getByRole('button', { name: 'Cancel' }).parentElement?.className).toMatch(
      /flex-wrap/,
    );
  });

  test('unmounting and reopening discards write-only credential drafts', () => {
    const props = {
      onSave: vi.fn(async () => {}),
      onRunTest: vi.fn(async () => PASS),
      onClose: vi.fn(),
    };
    const first = render(<SlackConnectWizard {...props} />);
    fireEvent.change(screen.getByLabelText(/app token/i), {
      target: { value: 'xapp-private' },
    });
    fireEvent.change(screen.getByLabelText(/bot token/i), {
      target: { value: 'xoxb-private' },
    });
    first.unmount();

    render(<SlackConnectWizard {...props} />);

    expect((screen.getByLabelText(/app token/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/bot token/i) as HTMLInputElement).value).toBe('');
  });

  test('Edit Slack uses blank write-only app and bot tokens and removes the HTTP signing secret', async () => {
    const onSave = vi.fn(async () => {});
    const props = {
      mode: 'edit',
      onSave,
      onRunTest: vi.fn(async () => PASS),
      onClose: vi.fn(),
    } as unknown as Parameters<typeof SlackConnectWizard>[0];
    render(<SlackConnectWizard {...props} />);

    expect(screen.getByRole('dialog', { name: 'Edit Slack' })).toBeDefined();
    expect((screen.getByLabelText(/app token/i) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText(/bot token/i) as HTMLInputElement).value).toBe('');
    expect(screen.queryByLabelText(/signing secret/i)).toBeNull();

    fireEvent.change(screen.getByLabelText(/app token/i), { target: { value: 'xapp-rotated' } });
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: /save and verify/i }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({ appToken: 'xapp-rotated' });
  });
});
