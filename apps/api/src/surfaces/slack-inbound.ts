import { scrubSecrets } from '@sre/agent-tools';
import { slackInboundConnector, type InboundCandidate } from '@sre/connectors';
import {
  getBindingByExternal,
  getSignalByExternal,
  getSurfaceMessageDecisionTx,
  hasPendingSurfaceMessageClassification,
  listSignalsByExternalRoot,
  recordAttachmentTx,
  threadExternalId,
  withSurfaceInboundMessageLock,
  withTenant,
  type Tx,
} from '@sre/db';
import { createHash } from 'node:crypto';
import type {
  SlackConfig,
  SlackEnvelope,
  SlackInboundDeps,
  SlackInteraction,
  SlackProcessorOutcome,
} from './slack-inbound/contracts';
import { dispatchSlackClassify, insertSlackClassifyTx } from './slack-inbound/classify';
import { processSlackInteraction } from './slack-inbound/interaction';
import { processSlackMention } from './slack-inbound/mention';
import { applySlackInboundSuppression } from './slack-inbound/suppression';
import {
  appendHumanReceiptTx,
  appendSourceThreadNoticeTx,
  inboundAllowed,
  incidentAcceptsReplyTx,
  parseSlackFiles,
  resolveAuthorUserId,
} from './slack-inbound/support';

export * from './slack-inbound/contracts';

async function admitSlackCandidate(
  deps: SlackInboundDeps,
  configId: string,
  config: SlackConfig,
  candidate: InboundCandidate,
): Promise<SlackProcessorOutcome> {
  const identity = {
    tenantId: config.tenantId,
    surface: 'slack',
    channel: candidate.channel,
    externalMessageId: candidate.externalId,
  };
  const admission = await withSurfaceInboundMessageLock(deps.adminDb, identity, async (tx) => {
    if (candidate.isEdit) {
      const scrubbedText = scrubSecrets(candidate.text);
      const scrubbedCandidate = {
        ...candidate,
        text: scrubbedText,
        contentHash: createHash('sha256').update(scrubbedText).digest('hex'),
      };
      const [plainSignal, groupedSignals] = await Promise.all([
        getSignalByExternal(
          deps.appDb,
          config.tenantId,
          'slack',
          scrubbedCandidate.channel,
          scrubbedCandidate.externalId,
        ),
        listSignalsByExternalRoot(
          deps.appDb,
          config.tenantId,
          'slack',
          scrubbedCandidate.channel,
          scrubbedCandidate.externalId,
        ),
      ]);
      const tracked = plainSignal !== null || groupedSignals.length > 0;
      const [messageDecision, pendingClassification] = tracked
        ? [null, false]
        : await Promise.all([
            getSurfaceMessageDecisionTx(tx, identity),
            hasPendingSurfaceMessageClassification(tx, {
              ...identity,
              excludeIntakeId: scrubbedCandidate.intakeId,
            }),
          ]);
      const hasTerminalDecision = messageDecision?.disposition != null;
      const replacesSuppression =
        hasTerminalDecision && scrubbedCandidate.signalState !== 'resolved';
      const isActionableProviderEdit =
        !tracked && scrubbedCandidate.author === 'bot' && scrubbedCandidate.alertKind === 'firing';
      const classifyAsRoot = replacesSuppression || isActionableProviderEdit;
      if (!tracked && !pendingClassification && !classifyAsRoot)
        return { status: 'dropped', outcome: 'dropped_untracked_edit' } as const;

      const payload = {
        ...scrubbedCandidate,
        raw: null,
        ...(classifyAsRoot ? { isEdit: false } : {}),
      };
      return {
        status: 'persisted',
        candidate: scrubbedCandidate,
        durable: await insertSlackClassifyTx(deps, tx, config, payload),
        successOutcome: 'edit_enqueued',
      } as const;
    }

    return {
      status: 'persisted',
      candidate,
      durable: await insertSlackClassifyTx(deps, tx, config, candidate),
      successOutcome: 'classify_enqueued',
    } as const;
  });
  if (admission.status === 'dropped') return admission.outcome;
  return dispatchSlackClassify(
    deps,
    configId,
    config,
    admission.candidate,
    admission.durable,
    admission.successOutcome,
  );
}

async function processSlackEvent(
  deps: SlackInboundDeps,
  configId: string,
  config: SlackConfig,
  envelope: SlackEnvelope,
  context: { intakeId?: string },
): Promise<SlackProcessorOutcome> {
  const ev = envelope.event;

  // Mention suppression: Slack delivers a human @-mention as BOTH an `app_mention` event and a
  // `message` event. The app_mention branch below owns it; drop the `message` twin from the classify
  // producer AND the resume path so a mention is never double-processed. Guarded on a non-empty
  // botUserId so an unconfigured config's `<@>` cannot match arbitrary text.
  const botMention = config.botUserId ? `<@${config.botUserId}>` : null;
  if (
    botMention &&
    envelope.type === 'event_callback' &&
    ev?.type === 'message' &&
    typeof ev.text === 'string' &&
    ev.text.includes(botMention)
  ) {
    return 'dropped_mention_twin';
  }

  // Human bot-mention pull path: a human @-mention CREATES an incident bypassing the worthy
  // classifier (the human is the gate), keyed on channel:root_ts. A mention in a thread we already
  // track resumes that incident instead. Same opt-in gate as the classify branch: inbound enabled on
  // the config AND the source channel allowlisted; either miss is a benign ack (Slack won't retry).
  const mentionOutcome = await processSlackMention(deps, configId, config, envelope, context);
  if (mentionOutcome) return mentionOutcome;

  // Inbound-classify branch: a provider root or provider-authored resolved thread reply is a
  // triage candidate, distinct from the human thread-reply resume path below. Same-app incoming webhooks
  // are valid alert producers, so identity is not a root-message loop guard. The adapter rejects every
  // other thread reply. When the adapter admits a candidate we commit to this branch.
  if (envelope.type === 'event_callback' && ev?.type === 'message') {
    const evaluation = slackInboundConnector.evaluate(ev, {
      botUserId: config.botUserId,
    });
    if (evaluation) {
      const candidate = { ...evaluation.candidate, intakeId: context.intakeId };
      // Per-channel opt-in: either miss is a benign outcome the Socket manager acknowledges.
      if (!(await inboundAllowed(deps, config, candidate.channel))) return 'dropped_unsubscribed';
      if (evaluation.disposition === 'suppress') {
        await applySlackInboundSuppression(deps, configId, config, candidate, evaluation.reason);
        return `suppressed_${evaluation.reason}`;
      }
      return admitSlackCandidate(deps, configId, config, candidate);
    }
  }

  // Resume on a human's thread-reply in a thread we TRACK. The binding is the gate: an
  // incident's thread lives in whatever channel its alert arrived in, not in some configured channel —
  // comparing against one silently dropped every reply outside it. Ignore bot messages and
  // non-thread messages. Accepted subtypes: none (a plain reply),
  // `thread_broadcast` (a reply
  // "also sent to channel"), and `file_share` WHEN it carries files — a human dropping a screenshot
  // into the thread is a human finding to triage. Every other subtype
  // (edit/delete/join) is not a new instruction and is dropped. A file_share may have no caption, so
  // the message is admitted on EITHER text or files; the attachment itself is the signal.
  const files = parseSlackFiles(ev?.files);
  const hasFiles = files.length > 0;
  const text = ev?.text?.trim() ?? '';
  const subtype = ev?.subtype;
  const subtypeAllowed =
    !subtype || subtype === 'thread_broadcast' || (subtype === 'file_share' && hasFiles);
  if (
    envelope.type !== 'event_callback' ||
    ev?.type !== 'message' ||
    !subtypeAllowed ||
    ev.bot_id ||
    (!text && !hasFiles) ||
    !ev.thread_ts ||
    !ev.channel
  ) {
    return 'dropped_no_candidate';
  }
  // A pure-screenshot reply carries no caption; synthesize a short human message so the hub row and
  // the resumed turn have content (the vision interpretation is injected as engine context later).
  // Human text is scrubbed at ingest so a pasted credential is never persisted raw
  // nor egressed to the LLM on resume; the synthesized caption is ours and carries nothing to scrub.
  const content = text
    ? scrubSecrets(text)
    : `(shared ${files.length} file${files.length === 1 ? '' : 's'})`;

  // Per-channel opt-in applies HERE too, not just to new signals. The subscription is the
  // platform's only per-channel inbound control, so an operator who disables a channel must stop the
  // threads it already created as well — otherwise anyone in that channel keeps driving the engine
  // (tools, connector reads, LLM egress) under an old incident. A binding is not a standing grant.
  if (!(await inboundAllowed(deps, config, ev.channel))) return 'dropped_unsubscribed';

  const binding = await getBindingByExternal(
    deps.appDb,
    config.tenantId,
    'slack',
    threadExternalId({ channel: ev.channel, threadId: ev.thread_ts }),
  );
  if (!binding) return 'dropped_untracked_thread'; // the reply is in a thread we don't track

  // Ingest as a human reply and resume (mirrors apps/api/src/surfaces/session.ts). originSurface marks
  // it 'slack' so the outbound fan-out does not echo it back to Slack (it still syncs to other surfaces).
  // The append + coalescing resume-job insert share ONE tx so a second reply that lands while a
  // resume is still queued coalesces onto it instead of unique-violating. Attachments are
  // captured at INGEST inside this same tx, so a coalesced reply never loses
  // its files; metadata only, interpretation null, tied to this human message.
  // Idempotency is the durable Slack channel+message-ts origin key on that hub row, not a pre-commit
  // Valkey reservation. A process death before commit therefore leaves nothing that can suppress Slack's
  // retry; a death after commit returns the same message and does not insert another resume job.
  // Resolve the author BEFORE opening the tx: the users.info round-trip must not hold a DB
  // connection open, and a failed resolve is non-fatal (null → unattributed, reply still lands).
  const authorUserId = await resolveAuthorUserId(deps, config, 'slack', ev.user ?? '');

  const result = await withTenant(deps.appDb, config.tenantId, async (tx: Tx) => {
    if (!(await incidentAcceptsReplyTx(tx, config.tenantId, binding.incidentId))) {
      return { archived: true as const };
    }
    const appendResult = await deps.hub.appendTxOnce(tx, config.tenantId, binding.incidentId, {
      author: 'human',
      content,
      originSurface: 'slack',
      originMessageId: `slack:${ev.channel}:${ev.ts}`,
      authorUserId,
    });
    const posted = appendResult.message;
    if (posted.incidentId !== binding.incidentId) {
      throw new Error('Slack reply origin is already attached to a different incident');
    }
    for (const file of files) {
      await recordAttachmentTx(tx, config.tenantId, {
        incidentId: binding.incidentId,
        messageId: posted.id,
        ...file,
      });
    }
    const receipt = await appendHumanReceiptTx(
      deps,
      tx,
      config.tenantId,
      binding.incidentId,
      posted.id,
    );
    if (!appendResult.inserted) {
      const notice = await appendSourceThreadNoticeTx(
        deps,
        tx,
        config.tenantId,
        binding,
        posted.id,
      );
      return {
        archived: false as const,
        appended: posted,
        sourceNotice: notice,
        receipt,
        inserted: false,
        resumeJobId: null,
      };
    }
    const notice = await appendSourceThreadNoticeTx(deps, tx, config.tenantId, binding, posted.id);
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
      inserted: true,
      resumeJobId: jobId,
    };
  });

  if (result.archived) return 'dropped_archived';

  // Post-commit fan-out + dispatch (best-effort; the reply + job are already durable). Publish the hub
  // line even on a redelivery so a commit-before-publish crash is healed; consumers dedupe on message id.
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

  return result.inserted ? 'resume_enqueued' : 'dropped_duplicate';
}

export async function handleSlackEvent(
  deps: SlackInboundDeps,
  configId: string,
  config: SlackConfig,
  envelope: SlackEnvelope,
  context: { intakeId?: string } = {},
): Promise<SlackProcessorOutcome> {
  return processSlackEvent(deps, configId, config, envelope, context);
}

export async function handleSlackInteraction(
  deps: SlackInboundDeps,
  configId: string,
  config: SlackConfig,
  payload: SlackInteraction,
): Promise<SlackProcessorOutcome> {
  return processSlackInteraction(deps, configId, config, payload);
}
