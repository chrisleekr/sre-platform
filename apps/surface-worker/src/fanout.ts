import { SURFACE_MIRRORED_KINDS, incidentUrl, postmortemUrl, type HubMessage } from '@sre/hub';
import { SlackApiError, type Surface, type SurfacePoster, type SurfaceTarget } from '@sre/surfaces';
import type {
  DeliveryTarget,
  FanoutDeps,
  OutboxRecoveryHint,
  ThreadBinding,
} from './fanout-contracts';
import {
  LifecycleProjectionBlockedError,
  SAFE_RETRY_DELAY_MS,
  acquireBlocking,
  activityLine,
  memoFor,
  type SurfaceApplyResult,
} from './fanout-support';

export * from './fanout-contracts';

async function applyToSurface(
  deps: FanoutDeps,
  poster: SurfacePoster,
  target: SurfaceTarget,
  threadId: string,
  surface: Surface,
  bindingId: string,
  bindingAssignmentVersion: number,
  tenantId: string,
  msg: HubMessage,
): Promise<SurfaceApplyResult> {
  const incidentId = msg.incidentId;

  if (msg.kind === 'lifecycle') {
    const version = msg.lifecycleVersion;
    if (version === null || version === undefined) {
      throw new Error('lifecycle message missing version');
    }
    const statusPost = await deps.getStatusPost(tenantId, surface, bindingId);
    if (!statusPost) throw new Error('lifecycle projection missing surface binding');
    if (statusPost.messageId && statusPost.version >= version) {
      return {
        operation: 'update',
        remoteMessageId: statusPost.messageId,
        skipped: true,
        skipReason: 'stale_lifecycle_version',
      };
    }
    const link = incidentUrl(deps.dashboardBaseUrl, incidentId);
    if (statusPost.messageId) {
      await poster.update(target, statusPost.messageId, msg, link);
      const advanced = await deps.advanceStatusPost(
        tenantId,
        surface,
        bindingId,
        incidentId,
        bindingAssignmentVersion,
        statusPost.messageId,
        version,
      );
      if (!advanced) throw new Error('lifecycle status projection lost its version fence');
      return { operation: 'update', remoteMessageId: statusPost.messageId };
    }
    if (await deps.hasAmbiguousStatusPostCreation(tenantId, surface, bindingId, msg.id)) {
      throw new LifecycleProjectionBlockedError();
    }
    const messageId = await poster.post(target, threadId, msg, link);
    const advanced = await deps.advanceStatusPost(
      tenantId,
      surface,
      bindingId,
      incidentId,
      bindingAssignmentVersion,
      messageId,
      version,
    );
    if (!advanced) throw new Error('lifecycle status projection lost its creation fence');
    return { operation: 'post', remoteMessageId: messageId };
  }

  // System messages (degrade text/finding) and approvals are their own posts, never the working post.
  if (msg.author !== 'agent' || msg.kind === 'approval') {
    // A postmortem draft is its own post carrying the postmortem deep link, never the incident one.
    if (msg.kind === 'postmortem') {
      const link = postmortemUrl(deps.dashboardBaseUrl, incidentId);
      const remoteMessageId = await poster.post(target, threadId, msg, link);
      return { operation: 'post', remoteMessageId };
    }
    if (msg.kind === 'relationship') {
      const link = incidentUrl(deps.dashboardBaseUrl, incidentId);
      const correlationPrefix = `correlated-source:${surface}:${target.channel}:`;
      const handsOffThisThread =
        msg.originMessageId?.startsWith(correlationPrefix) === true &&
        msg.originMessageId !== `${correlationPrefix}${threadId}`;
      if (handsOffThisThread) {
        const dangling = await deps.getWorkingPost(tenantId, bindingId);
        if (dangling) {
          await poster.update(target, dangling, msg, link);
          await deps.clearWorkingPost(tenantId, bindingId);
          return { operation: 'update', remoteMessageId: dangling };
        }
      }
      const remoteMessageId = await poster.post(target, threadId, msg, link);
      return { operation: 'post', remoteMessageId };
    }
    // A degrade `finding` concludes a failed turn: drop any dangling "🔍 …" working post FIRST (delete +
    // clear), then post the degrade note. clearWorkingPost removes the record, so the trailing system
    // `text` finds none and just posts. No misleading `silent` row is written to the hub.
    if (msg.kind === 'finding') {
      const dangling = await deps.getWorkingPost(tenantId, bindingId);
      if (dangling) {
        await poster.delete(target, dangling);
        await deps.clearWorkingPost(tenantId, bindingId);
      }
    }
    // Attribute a human reply synced FROM THE DASHBOARD to Slack: resolve the author's label at
    // dispatch and stamp it transiently. Gated on dashboard origin so the "(via dashboard)" wording stays
    // accurate — a slack-origin reply (or a system degrade note) has no such label and posts unchanged.
    const authorLabel =
      msg.authorUserId && msg.originSurface === 'dashboard'
        ? await deps.resolveAuthorLabel(tenantId, msg.authorUserId)
        : null;
    const remoteMessageId = await poster.post(
      target,
      threadId,
      authorLabel ? { ...msg, authorLabel } : msg,
    );
    return {
      operation: msg.kind === 'finding' ? 'composite' : 'post',
      remoteMessageId,
    };
  }

  const workingPost = await deps.getWorkingPost(tenantId, bindingId);

  // Agent narration: one evolving activity post; the full step detail stays in the hub.
  if (msg.kind === 'text' || msg.kind === 'tool_step') {
    const activity: HubMessage = { ...msg, summary: activityLine(msg) };
    if (workingPost) {
      await poster.update(target, workingPost, activity);
      return { operation: 'update', remoteMessageId: workingPost };
    } else {
      const messageId = await poster.post(target, threadId, activity);
      await deps.setWorkingPost(tenantId, bindingId, messageId);
      return { operation: 'post', remoteMessageId: messageId };
    }
  }

  // Agent conclusion: fold the working post into the terminal answer + dashboard link, then clear it.
  if (msg.kind === 'reply' || msg.kind === 'finding') {
    const link = incidentUrl(deps.dashboardBaseUrl, incidentId);
    if (workingPost) {
      await poster.update(target, workingPost, msg, link);
      await deps.clearWorkingPost(tenantId, bindingId);
      return { operation: 'update', remoteMessageId: workingPost };
    } else {
      const messageId = await poster.post(target, threadId, msg, link);
      return { operation: 'post', remoteMessageId: messageId };
    }
  }

  // Agent `silent` — keep the human-visible acknowledgement instead of deleting the only proof that the
  // platform accepted their message. The durable hub row remains silent; this is surface feedback only.
  if (workingPost) {
    await poster.update(target, workingPost, {
      ...msg,
      kind: 'reply',
      content: 'No additional response was needed.',
      summary: 'Message received.',
    });
    await deps.clearWorkingPost(tenantId, bindingId);
    return { operation: 'update', remoteMessageId: workingPost };
  }
  return {
    operation: 'delete',
    remoteMessageId: null,
    skipped: true,
    skipReason: 'nothing_to_delete',
  };
}

/**
 * Mirror one hub message to every destination captured by its durable outbox. A Postgres queued->sending
 * CAS ensures a redelivered stream entry cannot repeat an external attempt. The per-binding lock
 * serializes the projection so the
 * working-post create/update/delete never races a concurrent delivery; layered on the working-post store,
 * a redelivered first message UPDATES the stored post rather than double-creating. A loser that never
 * wins the lock delays the queued delivery and returns false so the stream can defer its entry. Origin
 * surfaces were excluded when the outbox row was created. `status` is HUB-ONLY, filtered by
 * SURFACE_MIRRORED_KINDS.
 */
export async function fanoutHubMessage(
  deps: FanoutDeps,
  msg: HubMessage,
  recovery?: OutboxRecoveryHint,
): Promise<boolean> {
  if (!SURFACE_MIRRORED_KINDS.has(msg.kind)) return true;

  // Aggregation: any surface that could not serialize delays its row. The durable claim skips
  // ineligible, already-owned, or terminal destinations.
  let deferred = false;

  let tenantId: string | null = recovery?.tenantId ?? null;
  if (!tenantId)
    try {
      tenantId = await deps.resolveTenant(msg.incidentId);
    } catch (err) {
      deps.onError?.(err, { incidentId: msg.incidentId, surface: 'resolve' });
      return true;
    }
  if (!tenantId) return true;

  let targets: DeliveryTarget[] = recovery?.targets ?? [];
  if (!recovery)
    try {
      targets = await deps.listDeliveryTargets(tenantId, msg.id);
    } catch (err) {
      deps.onError?.(err, { incidentId: msg.incidentId, surface: 'resolve' });
      return true;
    }

  for (const { surface, bindingId, bindingAssignmentVersion } of targets) {
    const poster = deps.registry.get(surface);
    if (!poster) {
      await deps.blockDelivery(tenantId, surface, bindingId, msg.id, 'adapter_unavailable');
      continue;
    }

    // Destination resolution happens before the durable attempt claim. A token/binding read cannot make
    // an external side effect, so a transient read failure can safely defer and retry.
    let token: string | null;
    let binding: ThreadBinding | null;
    try {
      // A disconnect revokes authorization, so the credential is read for every delivery. The binding is
      // immutable per incident and remains safe to memoize.
      const memo = memoFor(deps, `${tenantId}:${surface}:${bindingId}`);
      token = await deps.getToken(tenantId, surface);
      // The binding IS the destination: its channel addresses the API call and its thread id is
      // only meaningful inside that channel. Taking the channel from anywhere else posts a thread_ts that
      // does not exist there, and the answer never appears under the alert. Immutable, so cache it once.
      if (!token) binding = null;
      else if (memo.binding) binding = memo.binding;
      else {
        binding = await deps.getBinding(tenantId, surface, bindingId);
        if (binding) memo.binding = binding; // a missing binding is a transient fault; never freeze it
      }
    } catch (err) {
      // A DB/secret read failed before claim: schedule a safe retry without blocking later rows.
      deps.onError?.(err, { incidentId: msg.incidentId, surface });
      await deps
        .scheduleDeliveryRetry(
          tenantId,
          surface,
          bindingId,
          msg.id,
          'queued',
          new Date((deps.now?.() ?? Date.now()) + SAFE_RETRY_DELAY_MS),
          'dependency_unavailable',
        )
        .catch((retryErr) => deps.onError?.(retryErr, { incidentId: msg.incidentId, surface }));
      deferred = true;
      continue;
    }

    if (!token) {
      await deps.blockDelivery(tenantId, surface, bindingId, msg.id, 'not_connected');
      continue;
    }

    // The binding commits in the SAME transaction as the incident, so a connected surface always
    // has one. Its absence means an incident the AI cannot speak about: report it and block the durable
    // delivery rather than guessing a destination.
    if (!binding) {
      deps.onError?.(
        new Error(
          `no ${surface} binding for incident ${msg.incidentId} — the thread it was born in is missing`,
        ),
        { incidentId: msg.incidentId, surface },
      );
      await deps.blockDelivery(tenantId, surface, bindingId, msg.id, 'missing_binding');
      continue;
    }

    const target: SurfaceTarget = { token, channel: binding.channel };
    const lockKey = `surface:binding:${bindingId}`;
    const lockToken = await acquireBlocking(deps.lock, lockKey);
    if (!lockToken) {
      // Never serialized (holder overran): delay this row so later outbox work is still eligible.
      await deps
        .scheduleDeliveryRetry(
          tenantId,
          surface,
          bindingId,
          msg.id,
          'queued',
          new Date((deps.now?.() ?? Date.now()) + SAFE_RETRY_DELAY_MS),
          'projection_busy',
        )
        .catch((retryErr) => deps.onError?.(retryErr, { incidentId: msg.incidentId, surface }));
      deferred = true;
    } else {
      let renewalFailed = false;
      const renewTimer = setInterval(() => {
        void deps.lock
          .renew(lockKey, lockToken)
          .then((renewed) => {
            if (!renewed) renewalFailed = true;
          })
          .catch(() => {
            renewalFailed = true;
          });
      }, 10_000);
      try {
        const claimed = await deps.claimDelivery(tenantId, surface, bindingId, msg.id);
        if (!claimed) continue;
        const result = await applyToSurface(
          deps,
          poster,
          target,
          binding.threadId,
          surface,
          bindingId,
          bindingAssignmentVersion,
          tenantId,
          msg,
        );
        if (renewalFailed || !(await deps.lock.renew(lockKey, lockToken))) {
          throw new Error('surface projection lease was lost');
        }
        await deps.finishDelivery(tenantId, surface, bindingId, msg.id, {
          state: result.skipped ? 'skipped' : 'accepted',
          operation: result.operation,
          remoteMessageId: result.remoteMessageId,
          reasonCode: result.skipped ? (result.skipReason ?? 'nothing_to_delete') : null,
        });
      } catch (err) {
        if (err instanceof LifecycleProjectionBlockedError) {
          deps.onError?.(err, { incidentId: msg.incidentId, surface });
          await deps.finishDelivery(tenantId, surface, bindingId, msg.id, {
            state: 'blocked',
            operation: 'composite',
            reasonCode: 'prior_status_post_uncertain',
          });
          continue;
        }
        if (err instanceof SlackApiError && err.certainty === 'retryable') {
          deps.onError?.(err, { incidentId: msg.incidentId, surface });
          await deps.scheduleDeliveryRetry(
            tenantId,
            surface,
            bindingId,
            msg.id,
            'sending',
            new Date((deps.now?.() ?? Date.now()) + (err.retryAfterMs ?? 1_000)),
            'rate_limited',
          );
          continue;
        }
        // A poster failure is terminal for this attempt. Definitive Slack rejections are `rejected`;
        // 5xx/network/timeout outcomes are `uncertain` because Slack may have accepted before the failure.
        // Neither is automatically retried, which avoids duplicating an ambiguous post.
        deps.onError?.(err, { incidentId: msg.incidentId, surface });
        const state =
          err instanceof SlackApiError && err.certainty === 'rejected' ? 'rejected' : 'uncertain';
        const reasonCode =
          err instanceof SlackApiError
            ? err.code === 'invalid_auth'
              ? 'invalid_auth'
              : err.certainty === 'rejected'
                ? 'slack_rejected'
                : err.code
            : 'unexpected_poster_failure';
        await deps
          .finishDelivery(tenantId, surface, bindingId, msg.id, {
            state,
            operation: 'composite',
            reasonCode,
          })
          .catch((finishErr) => deps.onError?.(finishErr, { incidentId: msg.incidentId, surface }));
      } finally {
        clearInterval(renewTimer);
        await deps.lock.release(lockKey, lockToken);
      }
    }
  }

  return !deferred; // false = a safe pre-request retry was durably delayed
}
