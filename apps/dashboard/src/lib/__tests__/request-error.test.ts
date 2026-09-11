import { describe, expect, test } from 'vitest';
import { checkResponse, RequestError, requestErrorMessage } from '../request-error';

describe('platform API error presentation', () => {
  test('uses action-specific guidance instead of displaying an opaque machine code', async () => {
    await expect(
      checkResponse(
        Response.json({ error: 'stale' }, { status: 409 }),
        'Incident state changed. Review it and try again.',
      ),
    ).rejects.toThrow('Incident state changed. Review it and try again.');
  });
  test('leaves successful response bodies available to the caller', async () => {
    const response = Response.json({ saved: true });
    await checkResponse(response, 'Save failed.');
    expect(await response.json()).toEqual({ saved: true });
  });

  test.each([400, 403, 404, 409, 422])('keeps actionable client rejection %i', async (status) => {
    await expect(
      checkResponse(
        Response.json({ error: 'A new credential is required.' }, { status }),
        'Save failed.',
      ),
    ).rejects.toMatchObject({ message: 'A new credential is required.', status });
  });

  test('explains duplicate names and supplies a recovery identifier', async () => {
    await expect(
      checkResponse(
        Response.json({ error: 'a data source with this name already exists' }, { status: 409 }),
        'Save failed.',
      ),
    ).rejects.toMatchObject({
      code: 'duplicate_data_source_name',
      message: expect.stringContaining('manage the existing connection'),
    });
  });

  test.each([500, 502, 503])('hides server exception bodies on %i', async (status) => {
    await expect(
      checkResponse(
        Response.json({ error: 'postgres://secret@internal/database' }, { status }),
        'Save unavailable. Retry.',
      ),
    ).rejects.toThrow('Save unavailable. Retry.');
  });

  test.each([
    null,
    { error: {} },
    { error: '' },
    { error: '<html>proxy</html>' },
    { error: 'x'.repeat(601) },
  ])('rejects malformed error envelopes: %j', async (body) => {
    await expect(
      checkResponse(Response.json(body, { status: 400 }), 'Check the values and retry.'),
    ).rejects.toThrow('Check the values and retry.');
  });

  test('handles an HTML proxy response without surfacing a JSON parsing exception', async () => {
    await expect(
      checkResponse(
        new Response('<html>Bad gateway</html>', { status: 502 }),
        'Service unavailable.',
      ),
    ).rejects.toThrow('Service unavailable.');
  });

  test('only displays classified API failures, not arbitrary exceptions', () => {
    expect(requestErrorMessage(new RequestError('Fix the name.', 409), 'Retry.')).toBe(
      'Fix the name.',
    );
    expect(requestErrorMessage(new Error('token=secret'), 'Retry.')).toBe('Retry.');
  });
});
