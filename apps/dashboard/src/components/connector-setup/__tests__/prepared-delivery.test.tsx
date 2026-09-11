// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { PrepareDelivery, PreparedDelivery } from '../../../lib/connector-delivery';
import { usePreparedDelivery } from '../usePreparedDelivery';

const address: PreparedDelivery = {
  setupId: '00000000-0000-4000-8000-000000000001',
  webhookPath: '/webhooks/github/00000000-0000-4000-8000-000000000001',
};
const channel = { ...address, smeeUrl: 'https://smee.io/stable-channel' };

function Harness({
  prepare,
  transport = 'smee',
  stored = false,
  hasSmeeUrl = false,
}: {
  prepare: PrepareDelivery;
  transport?: 'direct' | 'smee' | 'none';
  stored?: boolean;
  hasSmeeUrl?: boolean;
}) {
  const state = usePreparedDelivery({
    prepare,
    transport,
    existing: stored,
    storedSmee: stored,
    hasSmeeUrl,
  });
  return (
    <>
      <p>{state.smeeUrl ?? state.webhookPath ?? 'pending'}</p>
      <p>{state.error}</p>
      <button onClick={state.retry}>Retry</button>
    </>
  );
}

describe('early webhook preparation', () => {
  test('reuses one channel across StrictMode, rerenders, and delivery mode changes', async () => {
    const prepare = vi.fn<PrepareDelivery>().mockResolvedValue(channel);
    const view = render(
      <StrictMode>
        <Harness prepare={prepare} />
      </StrictMode>,
    );
    await screen.findByText(channel.smeeUrl);
    view.rerender(
      <StrictMode>
        <Harness prepare={prepare} transport="direct" />
      </StrictMode>,
    );
    view.rerender(
      <StrictMode>
        <Harness prepare={prepare} />
      </StrictMode>,
    );
    await act(async () => {});
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  test('waits for allocation before requesting a relay for the same identifier', async () => {
    let resolve!: (value: PreparedDelivery) => void;
    const prepare = vi
      .fn<PrepareDelivery>()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue(channel);
    const view = render(<Harness prepare={prepare} transport="direct" />);
    view.rerender(<Harness prepare={prepare} />);
    await act(async () => {
      resolve(address);
    });
    await screen.findByText(channel.smeeUrl);
    expect(prepare.mock.calls).toEqual([
      [{ transport: 'direct' }],
      [{ transport: 'smee', setupId: address.setupId }],
    ]);
  });

  test('reports a failure without looping and supports an explicit retry', async () => {
    const prepare = vi
      .fn<PrepareDelivery>()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(channel);
    render(<Harness prepare={prepare} />);
    await screen.findByText(/Could not prepare/);
    expect(prepare).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(channel.smeeUrl);
    expect(screen.queryByText(/Could not prepare/)).toBeNull();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  test('does not replace an existing saved relay', async () => {
    const prepare = vi.fn<PrepareDelivery>();
    render(<Harness prepare={prepare} stored />);
    await act(async () => {});
    expect(prepare).not.toHaveBeenCalled();
  });

  test('a manually supplied channel only needs local address allocation when Smee is unavailable', async () => {
    const prepare = vi
      .fn<PrepareDelivery>()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(address);
    const view = render(<Harness prepare={prepare} />);
    await screen.findByText(/Could not prepare/);
    view.rerender(<Harness prepare={prepare} hasSmeeUrl />);
    await screen.findByText(address.webhookPath);
    expect(prepare).toHaveBeenLastCalledWith({ transport: 'direct' });
    expect(screen.queryByText(/Could not prepare/)).toBeNull();
  });

  test('allows public delivery after Smee preparation fails', async () => {
    const prepare = vi
      .fn<PrepareDelivery>()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(address);
    const view = render(<Harness prepare={prepare} />);
    await screen.findByText(/Could not prepare/);
    view.rerender(<Harness prepare={prepare} transport="direct" />);
    await screen.findByText(address.webhookPath);
    expect(screen.queryByText(/Could not prepare/)).toBeNull();
    expect(prepare).toHaveBeenLastCalledWith({ transport: 'direct' });
  });

  test('does not let a late Smee failure block the selected public mode', async () => {
    let reject!: (error: Error) => void;
    const prepare = vi
      .fn<PrepareDelivery>()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(address);
    const view = render(<Harness prepare={prepare} />);
    view.rerender(<Harness prepare={prepare} transport="direct" />);
    await act(async () => {
      reject(new Error('unavailable'));
    });
    await screen.findByText(address.webhookPath);
    expect(screen.queryByText(/Could not prepare/)).toBeNull();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  test('does not start another request after the wizard closes', async () => {
    let resolve!: (value: PreparedDelivery) => void;
    const prepare = vi.fn<PrepareDelivery>().mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = render(<Harness prepare={prepare} transport="direct" />);
    view.rerender(<Harness prepare={prepare} />);
    view.unmount();
    await act(async () => {
      resolve(address);
    });
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
  });
});
