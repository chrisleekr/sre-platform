// @vitest-environment jsdom
import { StrictMode, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { installDialogMethods } from '../../test/dialog';
import { SetupDialog } from '../SetupDialog';
import { SetupActions } from '../SetupDialogSlots';
import { SetupProgress } from '../SetupProgress';

let dialogMethods: ReturnType<typeof installDialogMethods>;

beforeEach(() => {
  dialogMethods = installDialogMethods();
});

afterEach(() => {
  cleanup();
  dialogMethods.restore();
  vi.restoreAllMocks();
});

function Harness({ busy = false, onClose = vi.fn() }: { busy?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Open setup
      </button>
      {open && (
        <SetupDialog
          title="Connect Kubernetes"
          closeLabel="Cancel"
          busy={busy}
          returnFocusTo={triggerRef.current}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        >
          <label>
            Cluster name
            <input />
          </label>
        </SetupDialog>
      )}
    </>
  );
}

describe('SetupDialog', () => {
  test('opens as a named native modal and focuses its title', async () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Open setup' }));

    const dialog = screen.getByRole('dialog', { name: 'Connect Kubernetes' });
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialogMethods.showModal).toHaveBeenCalledTimes(1);
    const title = within(dialog).getByRole('heading', { name: 'Connect Kubernetes' });
    expect(title.getAttribute('tabindex')).toBe('-1');
    await waitFor(() => expect(document.activeElement).toBe(title));
  });

  test('offers an idle Cancel action and restores focus to the invoking control', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const trigger = screen.getByRole('button', { name: 'Open setup' });
    fireEvent.click(trigger);

    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Connect Kubernetes' })).getByRole('button', {
        name: 'Cancel',
      }),
    );

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Connect Kubernetes' })).toBeNull();
    expect(dialogMethods.close).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test('keeps title focus through Strict Mode effect replay and restores the exact trigger on close', async () => {
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    const trigger = screen.getByRole('button', { name: 'Open setup' });

    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Connect Kubernetes' });
    const title = within(dialog).getByRole('heading', { name: 'Connect Kubernetes' });
    await waitFor(() => expect(dialogMethods.showModal).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.activeElement).toBe(title));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test('safe Escape dismissal closes and restores focus', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const trigger = screen.getByRole('button', { name: 'Open setup' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Connect Kubernetes' });

    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Connect Kubernetes' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test('busy work disables Cancel and prevents native cancel dismissal', () => {
    const onClose = vi.fn();
    render(<Harness busy onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open setup' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect Kubernetes' });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;

    expect(cancel.disabled).toBe(true);
    const event = new Event('cancel', { bubbles: false, cancelable: true });
    fireEvent(dialog, event);

    expect(event.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Connect Kubernetes' })).toBeDefined();
  });

  test('unmount closes an open native dialog and restores the previous focus target', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'External trigger';
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = render(
      <SetupDialog title="Connect Kubernetes" closeLabel="Cancel" onClose={() => {}}>
        <p>Setup content</p>
      </SetupDialog>,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Connect Kubernetes' }),
      ),
    );

    unmount();

    expect(dialogMethods.close).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    trigger.remove();
  });

  test('applies constrained scrolling and viewport-relative width classes', () => {
    render(
      <SetupDialog title="Connect Kubernetes" closeLabel="Cancel" onClose={() => {}}>
        <p>Setup content</p>
      </SetupDialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Connect Kubernetes' });

    expect(dialog.className).toMatch(/max-w-/);
    expect(dialog.className).toMatch(/max-h-/);
    expect(dialog.className).toMatch(/overflow-hidden/);
    expect(dialog.querySelector('[data-dialog-body]')?.className).toMatch(/overflow-y-auto/);
    expect(dialog.className).toMatch(/w-\[calc\(100%-/);
  });

  test('keeps step navigation and changing actions outside the scroll body', () => {
    function Steps() {
      const [step, setStep] = useState(1);
      return (
        <SetupDialog title="Setup" closeLabel="Close" onClose={vi.fn()}>
          <SetupProgress steps={['Access', 'Verify']} current={step} />
          <p>Step content</p>
          <SetupActions>
            {step === 1 ? (
              <button onClick={() => setStep(2)}>Continue</button>
            ) : (
              <button onClick={() => setStep(1)}>Back</button>
            )}
          </SetupActions>
        </SetupDialog>
      );
    }
    render(<Steps />);
    const dialog = screen.getByRole('dialog', { name: 'Setup' });
    const body = dialog.querySelector('[data-dialog-body]')!;
    expect(body.contains(screen.getByRole('navigation', { name: 'Setup steps' }))).toBe(false);
    expect(body.contains(screen.getByRole('button', { name: 'Continue' }))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();
    expect(
      dialog.querySelector('footer')!.contains(screen.getByRole('button', { name: 'Back' })),
    ).toBe(true);
    expect(screen.getByText(/Step 2 of 2/)).toBeDefined();
  });

  test.each([
    ['compact', 'max-w-lg'],
    ['standard', 'max-w-2xl'],
    ['wide', 'max-w-6xl'],
  ] as const)('uses the %s width without changing modal behavior', (size, width) => {
    render(
      <SetupDialog title="Sized dialog" closeLabel="Close" size={size} onClose={vi.fn()}>
        Content
      </SetupDialog>,
    );
    expect(screen.getByRole('dialog').className).toContain(width);
    expect(dialogMethods.showModal).toHaveBeenCalled();
  });
});
