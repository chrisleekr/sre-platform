import { scrubSecrets } from '@sre/agent-tools';
import { type MentionCandidate } from '@sre/connectors';
import {
  getBindingByExternal,
  recordAttachmentTx,
  threadExternalId,
  withTenant,
  type Tx,
} from '@sre/db';
import type { HubMessage } from '@sre/hub';
import type {
  SlackConfig,
  SlackEnvelope,
  SlackInboundDeps,
  SlackProcessorOutcome,
} from './contracts';
import {
  appendHumanReceiptTx,
  appendSourceThreadNoticeTx,
  inboundAllowed,
  incidentAcceptsReplyTx,
  parseSlackFiles,
  resolveAuthorUserId,
  stripMention,
} from './support';
import { executeIncidentTagCommand, parseIncidentTagCommand } from './tag-command';

export async function processSlackMention(
  deps: SlackInboundDeps,
  configId: string,
  config: SlackConfig,
  envelope: SlackEnvelope,
  context: { intakeId?: string },
): Promise<SlackProcessorOutcome | null> {
  const ev = envelope.event;
  if (envelope.type === 'event_callback' && ev?.type === 'app_mention') {
    const channel = ev.channel;
    const mentionText = ev.text?.trim();
    const messageTs = ev.ts;
    if (!channel || !mentionText || !messageTs) return 'dropped_no_candidate';
    // Skip the mention path when botUserId is unconfigured: the twin-message suppression above is
    // guarded on a non-empty botUserId, so firing here would open a SECOND incident from the same
    // mention (once here, once via the un-suppressed `message` twin on the classify path). Acking
    // lets the mention flow through the normal classify path instead.
    if (!config.botUserId) return 'dropped_no_candidate';
    if (!(await inboundAllowed(deps, config, channel))) return 'dropped_unsubscribed';

    // The incident is keyed on the thread ROOT: a top-level mention roots at its own ts; a reply
    // roots at its thread_ts (never the reply's ts), so the whole thread maps to one incident.
    const rootTs = ev.thread_ts ?? messageTs;

    const key = `mention:${config.tenantId}:${channel}:${messageTs}`;
    const binding = await getBindingByExternal(
      deps.appDb,
      config.tenantId,
      'slack',
      threadExternalId({ channel, threadId: rootTs }),
    );

    if (binding) {
      // A tracked mention is a human conversation reply. Its short-lived reservation prevents Slack's
      // app_mention retry from appending the same instruction twice.
      if ((await deps.redis.set(key, '1', 'EX', 86_400, 'NX')) === null) return 'dropped_duplicate';
      // Resume the tracked incident (mirrors the text thread-reply path): append the human's
      // instruction and insert the coalescing resume job in ONE tx, so a second reply landing
      // while a resume is still queued coalesces onto it instead of unique-violating. The ts
      // reservation covers append idempotency, so a lost post-commit publish is best-effort (onError) —
      // do NOT release/retry, or Slack would re-append.
      // Scrub at ingest: a human who pastes a credential must not have it persisted
      // raw in incident_messages nor egressed to the LLM on resume. Everything downstream reads the
      // appended row, so this is the single scrub point (mirrors the new-thread classify path).
      const content = scrubSecrets(stripMention(mentionText, config.botUserId) || mentionText);
      // Capture attachments at INGEST inside the same tx as the reply, so a
      // coalesced reply never loses its files. Metadata only, interpretation null, tied to this
      // human message; idempotent on (tenant, incident, file) so a Slack retry is a no-op.
      const files = parseSlackFiles(ev.files);
      // Resolve the author BEFORE the tx: non-fatal, cache-first, no users.info under an open tx.
      const authorUserId = await resolveAuthorUserId(deps, config, 'slack', ev.user ?? '');
      const tagCommand = parseIncidentTagCommand(content);
      if (tagCommand) {
        try {
          const commandResult = await executeIncidentTagCommand({
            deps,
            tenantId: config.tenantId,
            incidentId: binding.incidentId,
            content,
            authorUserId,
            command: tagCommand,
          });
          if (commandResult.archived) return 'dropped_archived';
          for (const message of commandResult.messages)
            await deps.hub
              .publishAppended(message)
              .catch((error) =>
                deps.onError?.(error, { configId, incidentId: binding.incidentId }),
              );
          return 'tag_command_handled';
        } catch (error) {
          await deps.redis.del(key).catch(() => {});
          throw error;
        }
      }
      let result:
        | { archived: true }
        | {
            archived: false;
            appended: HubMessage;
            sourceNotice: HubMessage | null;
            receipt: HubMessage;
            resumeJobId: string | null;
          };
      try {
        result = await withTenant(deps.appDb, config.tenantId, async (tx: Tx) => {
          if (!(await incidentAcceptsReplyTx(tx, config.tenantId, binding.incidentId))) {
            return { archived: true as const };
          }
          const posted = await deps.hub.appendTx(tx, config.tenantId, binding.incidentId, {
            author: 'human',
            content,
            originSurface: 'slack',
            authorUserId,
          });
          for (const file of files) {
            await recordAttachmentTx(tx, config.tenantId, {
              incidentId: binding.incidentId,
              messageId: posted.id,
              ...file,
            });
          }
          const notice = await appendSourceThreadNoticeTx(
            deps,
            tx,
            config.tenantId,
            binding,
            posted.id,
          );
          const receipt = await appendHumanReceiptTx(
            deps,
            tx,
            config.tenantId,
            binding.incidentId,
            posted.id,
          );
          const { jobId } = await deps.queue.insertResumeTx(
            tx,
            config.tenantId,
            binding.incidentId,
            posted.id,
          );
          return {
            archived: false as const,
            appended: posted,
            sourceNotice: notice,
            receipt,
            resumeJobId: jobId,
          };
        });
      } catch (err) {
        // Nothing durable happened yet (the shared tx rolled back): release so Slack's retry re-runs.
        await deps.redis.del(key).catch(() => {});
        throw err;
      }
      if (result.archived) return 'dropped_archived';
      // Post-commit fan-out + dispatch (Redis is not transactional): the reply + job are already
      // durable, so a failure here is best-effort — history replay + the reconciler recover it.
      await deps.hub
        .publishAppended(result.appended)
        .catch((err) => deps.onError?.(err, { configId, incidentId: binding.incidentId }));
      if (result.sourceNotice)
        await deps.hub
          .publishAppended(result.sourceNotice)
          .catch((err) => deps.onError?.(err, { configId, incidentId: binding.incidentId }));
      await deps.hub
        .publishAppended(result.receipt)
        .catch((err) => deps.onError?.(err, { configId, incidentId: binding.incidentId }));
      if (result.resumeJobId)
        await deps.queue
          .publishResume(result.resumeJobId)
          .catch((err) => deps.onError?.(err, { configId, incidentId: binding.incidentId }));
      return 'resume_enqueued';
    }

    // Untracked thread: make the mention classify job durable before the cache and stream dispatch. The
    // consumer reads the whole thread, opens the incident, and binds channel:root_ts. A retry after a
    // crash reuses the receipt- or event-keyed job instead of trusting a reservation with no job behind it.
    const candidate: MentionCandidate = {
      kind: 'mention',
      intakeId: context.intakeId,
      eventKey: `slack:${channel}:${messageTs}:mention`,
      channel,
      rootTs,
      ts: messageTs,
      user: ev.user ?? '',
      text: mentionText,
      raw: ev,
    };
    const durable = await deps.classifyQueue.insertClassify({
      tenantId: config.tenantId,
      type: 'classify',
      payload: candidate,
    });
    if (durable.inserted || durable.matchedBy === 'intake')
      await deps.redis
        .set(key, '1', 'EX', 86_400)
        .catch((error) => deps.onError?.(error, { configId }));
    await deps.classifyQueue
      .publishJob(durable.jobId)
      .catch((error) => deps.onError?.(error, { configId }));
    return durable.matchedBy === 'event' ? 'dropped_duplicate' : 'mention_enqueued';
  }
  return null;
}
