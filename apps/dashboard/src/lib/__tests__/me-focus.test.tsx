// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { resetMeStoreForTests, useMe } from '../me-store';

const ACTIVE = {
  user: { id: 'user-1', email: 'person@example.test', isPlatformAdmin: true },
  state: 'active',
  tenant: null,
  founding: null,
  workspaces: [],
};
const credentials = async () => ({ kind: 'cookie' as const });

function Draft() {
  const [value, setValue] = useState('');
  useMe(credentials, true, 'browser-session');
  return (
    <input aria-label="Unsaved setting" value={value} onChange={(e) => setValue(e.target.value)} />
  );
}

function Gate() {
  const me = useMe(credentials, true, 'browser-session');
  if (me.error) return <p role="alert">Access unavailable</p>;
  if (me.loading || !me.data) return <p>Loading access</p>;
  return me.data.user.isPlatformAdmin ? <Draft /> : <p>Access removed</p>;
}

afterEach(() => {
  cleanup();
  resetMeStoreForTests();
  vi.unstubAllGlobals();
});

test('focus revalidates once without unmounting the page or discarding an unsaved draft', async () => {
  let finish!: (response: Response) => void;
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(ACTIVE))
    .mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
  vi.stubGlobal('fetch', fetch);
  render(<Gate />);
  const input = await screen.findByLabelText('Unsaved setting');
  fireEvent.change(input, { target: { value: 'keep this draft' } });
  fireEvent.focus(window);
  fireEvent.focus(window);
  expect(screen.getByLabelText('Unsaved setting')).toBe(input);
  expect((input as HTMLInputElement).value).toBe('keep this draft');
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await act(async () => {
    finish(Response.json(ACTIVE));
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText('Unsaved setting')).toBe(input);
});

test.each(['revoked', 'failed'])(
  'focus revalidation still removes stale access when %s',
  async (result) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(ACTIVE))
      .mockResolvedValueOnce(
        result === 'revoked'
          ? Response.json({ ...ACTIVE, user: { ...ACTIVE.user, isPlatformAdmin: false } })
          : Response.json({}, { status: 503 }),
      );
    vi.stubGlobal('fetch', fetch);
    render(<Gate />);
    await screen.findByLabelText('Unsaved setting');
    fireEvent.focus(window);
    await screen.findByText(result === 'revoked' ? 'Access removed' : 'Access unavailable');
    expect(screen.queryByLabelText('Unsaved setting')).toBeNull();
  },
);
