// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useAttachments } from '../useAttachments';

afterEach(() => vi.unstubAllGlobals());

test('attachment failure is not presented as an empty successful list and can be retried', async () => {
  const attachment = {
    id: 'attachment',
    fileId: 'file',
    name: 'trace.txt',
    mimetype: 'text/plain',
    permalink: null,
    interpretation: null,
    messageId: null,
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: 'internal details' }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ attachments: [attachment] }));
  vi.stubGlobal('fetch', fetch);
  const credentials = async () => ({ kind: 'cookie' as const });
  const { result } = renderHook(() =>
    useAttachments('incident', {
      apiBaseUrl: 'https://api.example.test',
      getCredentials: credentials,
    }),
  );
  await waitFor(() => expect(result.current.error).toBe('Attachments could not be loaded. Retry.'));
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.attachments).toEqual([attachment]));
  expect(result.current.error).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});
