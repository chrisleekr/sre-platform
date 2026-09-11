// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import { IncidentTags } from '../IncidentTags';

vi.mock('../../lib/authenticatedFetch', () => ({ authenticatedFetch: vi.fn() }));

const fetchMock = vi.mocked(authenticatedFetch);

describe('IncidentTags', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  });

  test('supports historical completion, edited suggestion acceptance, and removal', async () => {
    const refresh = vi.fn();
    render(
      <IncidentTags
        incidentId="incident-1"
        getCredentials={async () => ({ kind: 'bearer' as const, token: 'token' })}
        refresh={refresh}
        data={{
          tags: [{ id: 'tag-1', tag: 'team:payments' }],
          suggestions: [{ id: 'suggestion-1', tag: 'cause:deployment' }],
          linkRules: [],
          historySuggestions: [{ tag: 'cause:database', appliedCount: 4 }],
        }}
      />,
    );

    expect(screen.queryByLabelText('Add tag')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review cause:deployment' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit tags' }));
    expect(document.querySelector('option[value="cause:database"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review cause:deployment' }));
    const input = screen.getByLabelText('Add tag');
    fireEvent.change(input, { target: { value: 'cause:release' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply suggestion' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/incidents/incident-1/tag-suggestions/suggestion-1/accept'),
        expect.any(Function),
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ tag: 'cause:release' }) }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove team:payments' }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/incidents/incident-1/tags/tag-1'),
        expect.any(Function),
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  test('shows a failed mutation and lets the responder retry without losing the draft', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const refresh = vi.fn();
    render(
      <IncidentTags
        incidentId="incident-1"
        getCredentials={async () => ({ kind: 'bearer' as const, token: 'token' })}
        refresh={refresh}
        data={{ tags: [], suggestions: [], linkRules: [], historySuggestions: [] }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    fireEvent.change(screen.getByLabelText('Add tag'), { target: { value: 'cause:release' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save tag' }));
    expect(await screen.findByText(/tag change failed/i)).toBeDefined();
    expect((screen.getByLabelText('Add tag') as HTMLInputElement).value).toBe('cause:release');

    fireEvent.click(screen.getByRole('button', { name: 'Save tag' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/tag change failed/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done editing tags' }));
    expect(screen.queryByLabelText('Add tag')).toBeNull();
  });
});
