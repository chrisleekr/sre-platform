import { describe, expect, test, vi } from 'vitest';

describe('due ticket promotion prompts', () => {
  test('missing Slack credentials fail before delivery can be acknowledged', async () => {
    const { makeSignalReminderPoster } = await import('../signal-maintenance');
    const postWithToken = vi.fn(async () => undefined);
    const poster = makeSignalReminderPoster({
      getToken: async () => null,
      postWithToken,
    });

    await expect(
      poster.post('tenant-1', { channel: 'C1', threadId: '1' }, 'review due'),
    ).rejects.toThrow(/token is unavailable/i);
    expect(postWithToken).not.toHaveBeenCalled();
  });

  test('prompts each due reviewed ticket once without creating an Incident', async () => {
    const { runDueTicketPromptSweep } = await import('../signal-maintenance');
    const due = [
      {
        id: 'ticket-1',
        tenantId: 'tenant-1',
        channel: 'C1',
        threadId: '1790000000.000100',
        promotionPromptClaimId: '00000000-0000-4000-8000-000000000001',
      },
    ];
    const listTenants = vi.fn(async () => [{ id: 'tenant-1' }]);
    const claimDue = vi.fn().mockResolvedValueOnce(due).mockResolvedValueOnce([]);
    const prompt = vi.fn(async () => undefined);
    const acknowledge = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);

    await expect(
      runDueTicketPromptSweep({
        listTenants,
        claimDue,
        prompt,
        acknowledge,
        release,
        limitPerTenant: 100,
      }),
    ).resolves.toEqual({ prompted: 1, failed: 0 });
    await expect(
      runDueTicketPromptSweep({
        listTenants,
        claimDue,
        prompt,
        acknowledge,
        release,
        limitPerTenant: 100,
      }),
    ).resolves.toEqual({ prompted: 0, failed: 0 });

    expect(claimDue).toHaveBeenNthCalledWith(1, 'tenant-1', 100);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith(due[0]);
    expect(acknowledge).toHaveBeenCalledWith(due[0]);
    expect(release).not.toHaveBeenCalled();
  });

  test('releases a failed delivery without blocking later tickets', async () => {
    const { runDueTicketPromptSweep } = await import('../signal-maintenance');
    const tickets = [
      {
        id: 'ticket-failed',
        tenantId: 'tenant-1',
        channel: 'C1',
        threadId: '1',
        promotionPromptClaimId: '00000000-0000-4000-8000-000000000001',
      },
      {
        id: 'ticket-delivered',
        tenantId: 'tenant-1',
        channel: 'C1',
        threadId: '2',
        promotionPromptClaimId: '00000000-0000-4000-8000-000000000002',
      },
    ];
    const prompt = vi
      .fn<(ticket: (typeof tickets)[number]) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Slack unavailable'))
      .mockResolvedValueOnce();
    const acknowledge = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);

    await expect(
      runDueTicketPromptSweep({
        listTenants: async () => [{ id: 'tenant-1' }],
        claimDue: async () => tickets,
        prompt,
        acknowledge,
        release,
        limitPerTenant: 100,
      }),
    ).resolves.toEqual({ prompted: 1, failed: 1 });
    expect(release).toHaveBeenCalledWith(tickets[0]);
    expect(acknowledge).toHaveBeenCalledWith(tickets[1]);
  });

  test('releases the durable claim when the production poster has no Slack token', async () => {
    const { makeSignalReminderPoster, runDueTicketPromptSweep } =
      await import('../signal-maintenance');
    const ticket = {
      id: 'ticket-no-token',
      tenantId: 'tenant-1',
      channel: 'C1',
      threadId: '1',
      promotionPromptClaimId: '00000000-0000-4000-8000-000000000001',
    };
    const poster = makeSignalReminderPoster({
      getToken: async () => null,
      postWithToken: vi.fn(async () => undefined),
    });
    const acknowledge = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);

    await expect(
      runDueTicketPromptSweep({
        listTenants: async () => [{ id: ticket.tenantId }],
        claimDue: async () => [ticket],
        prompt: (due) =>
          poster.post(due.tenantId, { channel: due.channel, threadId: due.threadId }, 'review due'),
        acknowledge,
        release,
        limitPerTenant: 100,
      }),
    ).resolves.toEqual({ prompted: 0, failed: 1 });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(ticket);
  });
});
