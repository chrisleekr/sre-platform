import { scrubSecrets } from '@sre/agent-tools';
import type { MentionCandidate } from '@sre/connectors';
import type { ZodType } from 'zod';
import {
  findSignalTicketByThread,
  getBindingByIncident,
  lockSignalTicketForPromotionTx,
  lookupSurfaceIdentity,
  markSignalPromotedTx,
  threadExternalId,
} from '@sre/db';
import type { Job } from '@sre/queue';
import { renderThread } from '@sre/surfaces';
import { characterizeThread } from '../engine/characterize';
import { resolveBelongsTo, type MentionVerdict } from '../engine/correlation';
import { publicModelText } from '../public-output';
import type { ClassifyAttachments } from './attachments';
import { DEGRADED_SEVERITY } from './contracts';
import type { ClassifyCore } from './core';
import { serviceForChannel } from './core';

function breadcrumbText(permalink?: string | null): string {
  return permalink
    ? `Consolidated into an existing incident already being tracked in <${permalink}|another thread>.`
    : 'Consolidated into an existing incident already being tracked in another thread.';
}

/** Accepts only an explicit standalone ticket-promotion command. */
export function isSignalPromotionCommand(text: string): boolean {
  const command = text.trim().replace(/^<@[A-Z0-9]+>\s*/i, '');
  return /^(?:investigate|promote)(?:\s+(?:this|ticket))?[.!]?$/i.test(command);
}

export class MentionHandler {
  constructor(
    private readonly core: ClassifyCore,
    private readonly attachments: ClassifyAttachments,
  ) {}

  async handle(candidate: MentionCandidate, job: Job, signal: AbortSignal): Promise<void> {
    const { deps } = this.core;
    const { threadReader, generator, hub, poster, resolvePermalink } = deps;
    if (!threadReader || (!generator && !deps.llm) || !hub)
      throw new Error('classify mention path is not wired (threadReader/generator/hub)');
    const tenantId = job.tenantId;
    const { channel, rootTs, ts, text } = candidate;
    const fingerprint = `slack:${channel}:${rootTs}`;
    const humanThread = { channel, threadId: rootTs };
    const authorUserId = await lookupSurfaceIdentity(deps.appDb, tenantId, 'slack', candidate.user);
    if (isSignalPromotionCommand(text)) {
      const ticket = await findSignalTicketByThread(deps.appDb, tenantId, 'slack', channel, rootTs);
      if (ticket) {
        if (ticket.incidentId) {
          await this.core.emitOutcome({
            intakeId: candidate.intakeId,
            tenantId,
            channel,
            messageId: ts,
            author: 'human',
            outcome: 'mention_new_incident',
            attempts: job.attempts,
          });
          return;
        }
        if (ticket.resolvedAt) {
          await poster?.post(tenantId, humanThread, 'Ticket not promoted: it is no longer open.');
          return;
        }
        const userId = await lookupSurfaceIdentity(deps.appDb, tenantId, 'slack', candidate.user);
        if (!userId) {
          await poster?.post(
            tenantId,
            humanThread,
            'Ticket not promoted: this Slack user is not mapped to a tenant member.',
          );
          return;
        }
        const routed = await this.core.routeOrRetry(
          {
            tenantId,
            source: ticket.source,
            fingerprint: `signal-ticket:${ticket.id}`,
            dedupKey: `signal-ticket:${ticket.id}:promote`,
            service: ticket.service ?? serviceForChannel(channel),
            severity: ticket.severity ?? DEGRADED_SEVERITY,
            title: ticket.summary,
            context: { signalDispositionId: ticket.id, summary: ticket.summary },
            origin: { surface: 'slack', channel, threadId: rootTs },
            investigationTrigger: {
              reason: 'manual_investigation',
              automatic: false,
              monitorKey: `signal-ticket:${ticket.id}`,
            },
            onRoutedTx: async (tx, result) => {
              const current = await lockSignalTicketForPromotionTx(tx, ticket.id);
              if (!current) throw new Error('signal ticket is no longer promotable');
              if (current.incidentId) {
                if (current.incidentId !== result.incidentId)
                  throw new Error('signal ticket is already linked to another incident');
                return;
              }
              const promoted = await markSignalPromotedTx(tx, ticket.id, {
                incidentId: result.incidentId,
                userId,
                surface: 'slack',
                actor: `slack:${candidate.user}`,
                criterion: 'other',
                reason: 'A mapped Slack responder promoted this ticket for investigation.',
              });
              if (!promoted) throw new Error('signal ticket promotion lost its attribution race');
            },
          },
          signal,
        );
        await this.core.emitOutcome({
          intakeId: candidate.intakeId,
          tenantId,
          channel,
          messageId: ts,
          author: 'human',
          outcome: routed.incidentId ? 'mention_new_incident' : 'mention_belongs_to',
          attempts: job.attempts,
        });
        return;
      }
    }
    let transcript: string;
    let priorThread = '';
    try {
      const messages = await threadReader.readThread(tenantId, channel, rootTs);
      const earlier = messages.filter((message) => message.ts !== ts);
      priorThread = renderThread(earlier);
      transcript = renderThread([...earlier, { user: candidate.user, text, ts }]);
    } catch {
      if (signal.aborted) throw signal.reason;
      transcript = text;
    }
    const scrubbed = scrubSecrets(transcript);
    const candidates = await this.core.buildCandidates(tenantId, scrubbed);
    const fallback: MentionVerdict = {
      decision: 'new_incident',
      service: serviceForChannel(channel),
      severity: DEGRADED_SEVERITY,
      title: scrubSecrets(text),
      purpose: 'incident',
    };
    let verdict: MentionVerdict;
    try {
      verdict = deps.llm
        ? await deps.llm.execute(
            { tenantId, jobId: job.id, operation: 'characterize', signal },
            ({ generator: current }) => characterizeThread(current, scrubbed, candidates),
          )
        : await characterizeThread(
            {
              generate<T>(prompt: string, schema: ZodType<T>) {
                return generator!.generate(prompt, schema, { signal });
              },
            },
            scrubbed,
            candidates,
          );
    } catch {
      if (signal.aborted) throw signal.reason;
      verdict = fallback;
    }
    if (verdict.decision === 'belongs_to') {
      const incidentId = resolveBelongsTo(verdict.index, candidates);
      if (incidentId) {
        const breadcrumb = async (): Promise<void> => {
          const binding = await getBindingByIncident(deps.appDb, tenantId, 'slack', incidentId);
          if (binding && binding.externalId === threadExternalId(humanThread)) return;
          let permalink: string | null = null;
          if (binding && resolvePermalink) {
            try {
              permalink = await resolvePermalink(tenantId, binding.channel, binding.threadId);
            } catch {
              permalink = null;
            }
          }
          void poster?.post(tenantId, humanThread, breadcrumbText(permalink)).catch(() => {});
        };
        await this.attachments.attachHuman(
          tenantId,
          incidentId,
          channel,
          ts,
          scrubSecrets(text),
          breadcrumb,
          true,
          authorUserId,
          scrubSecrets(priorThread),
        );
        await this.core.emitOutcome({
          intakeId: candidate.intakeId,
          tenantId,
          channel,
          messageId: ts,
          author: 'human',
          outcome: 'mention_belongs_to',
          attempts: job.attempts,
        });
        return;
      }
      verdict = fallback;
    }
    await this.core.openNewIncident(
      tenantId,
      fingerprint,
      { channel, threadId: rootTs },
      {
        service: publicModelText(verdict.service),
        severity: verdict.severity,
        title: publicModelText(verdict.title),
        purpose: verdict.purpose,
      },
      { currentMessage: scrubSecrets(text), priorThread: scrubSecrets(priorThread) },
      scrubbed,
      {
        author: 'human',
        content: scrubSecrets(text),
        authorUserId,
        originSurface: 'slack',
        originMessageId: this.core.messageKey(channel, ts),
      },
      (owner) =>
        this.attachments.attachHuman(
          tenantId,
          owner,
          channel,
          ts,
          scrubSecrets(text),
          undefined,
          true,
          authorUserId,
        ),
      {
        dedupKey: this.core.messageKey(channel, ts),
        investigationTrigger: {
          reason: 'manual_investigation',
          automatic: false,
          monitorKey: null,
        },
      },
    );
    await this.core.emitOutcome({
      intakeId: candidate.intakeId,
      tenantId,
      channel,
      messageId: ts,
      author: 'human',
      outcome: 'mention_new_incident',
      attempts: job.attempts,
    });
  }
}
