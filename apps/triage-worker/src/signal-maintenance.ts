export interface DueSignalTicket {
  id: string;
  tenantId: string;
  channel: string;
  threadId: string;
  promotionPromptClaimId: string;
}

/**
 * Creates a reminder poster that fails until a Slack delivery can actually be attempted.
 * @param dependencies - Token lookup and authenticated delivery seams.
 */
export function makeSignalReminderPoster(dependencies: {
  getToken(tenantId: string): Promise<string | null>;
  postWithToken(
    token: string,
    thread: { channel: string; threadId: string },
    text: string,
  ): Promise<void>;
}) {
  return {
    async post(
      tenantId: string,
      thread: { channel: string; threadId: string },
      text: string,
    ): Promise<void> {
      const token = await dependencies.getToken(tenantId);
      if (!token) throw new Error('Slack bot token is unavailable for ticket reminder delivery');
      await dependencies.postWithToken(token, thread, text);
    },
  };
}

/**
 * Claims and prompts due reviewed tickets once without promoting them.
 * @param dependencies - Tenant listing, atomic claim, and prompt seams.
 */
export async function runDueTicketPromptSweep(dependencies: {
  listTenants(): Promise<Array<{ id: string }>>;
  claimDue(tenantId: string, limit: number): Promise<DueSignalTicket[]>;
  prompt(ticket: DueSignalTicket): Promise<void>;
  acknowledge(ticket: DueSignalTicket): Promise<void>;
  release(ticket: DueSignalTicket): Promise<void>;
  limitPerTenant: number;
}): Promise<{ prompted: number; failed: number }> {
  let prompted = 0;
  let failed = 0;
  for (const tenant of await dependencies.listTenants()) {
    const tickets = await dependencies.claimDue(tenant.id, dependencies.limitPerTenant);
    for (const ticket of tickets) {
      try {
        await dependencies.prompt(ticket);
        await dependencies.acknowledge(ticket);
        prompted += 1;
      } catch {
        failed += 1;
        await dependencies.release(ticket);
      }
    }
  }
  return { prompted, failed };
}

/** Runs the production ticket-reminder and retention sweep across every tenant. */
export async function runSignalMaintenance(input: {
  adminDb: Db;
  appDb: Db;
  post(
    tenantId: string,
    thread: { channel: string; threadId: string },
    text: string,
  ): Promise<unknown>;
}): Promise<number> {
  const tenants = await listTenants(input.adminDb);
  const { prompted, failed } = await runDueTicketPromptSweep({
    listTenants: async () => tenants,
    claimDue: (tenantId, limit) => claimDueSignalPrompts(input.appDb, tenantId, limit),
    prompt: (ticket) =>
      input
        .post(
          ticket.tenantId,
          { channel: ticket.channel, threadId: ticket.threadId },
          'Ticket review is due. Mention the SRE app with `investigate` to promote it, or leave it deferred.',
        )
        .then(() => undefined),
    acknowledge: (ticket) =>
      acknowledgeSignalPrompt(
        input.appDb,
        ticket.tenantId,
        ticket.id,
        ticket.promotionPromptClaimId,
      ).then(() => undefined),
    release: (ticket) =>
      releaseSignalPrompt(
        input.appDb,
        ticket.tenantId,
        ticket.id,
        ticket.promotionPromptClaimId,
      ).then(() => undefined),
    limitPerTenant: 100,
  });
  let deleted = 0;
  for (const tenant of tenants)
    deleted += await sweepExpiredSignalDispositions(input.appDb, tenant.id, { limit: 500 });
  if (prompted || failed || deleted)
    console.log(
      JSON.stringify({
        level: 'info',
        app: 'triage-worker',
        event: 'signals.maintenance',
        prompted,
        failed,
        deleted,
      }),
    );
  return prompted + deleted;
}
import {
  acknowledgeSignalPrompt,
  claimDueSignalPrompts,
  listTenants,
  releaseSignalPrompt,
  sweepExpiredSignalDispositions,
  type Db,
} from '@sre/db';
