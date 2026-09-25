import {
  getApprovalById,
  decideApprovalTx,
  lockResponseGroupWorkTx,
  withTenant,
  type Db,
  type Tx,
} from '@sre/db';
import type { ConversationHub } from '@sre/hub';

// the single first-decision-wins decide path, shared by the dashboard route
// (apps/api/src/incidents.ts) and the Slack interactivity route (apps/api/src/surfaces/slack-inbound.ts)
// so the CAS + append + resume logic lives in exactly one place. Taps from different surfaces race to the
// same approvals row; the CAS in decideApproval makes exactly one win, and only the winner appends the
// 'decided' reply and enqueues the resume. Mirrors the human-reply pattern in surfaces/session.ts.

/** Reject a non-UUID approvalId before getApprovalById so a malformed id can't raise a Postgres uuid error (22P02 -> 500). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Coalescing resume producer, split into a tx half + a post-commit half so the resume job
 * shares the winning decision's transaction and rolls back with it — no phantom resume for a rolled-back
 * append. The @sre/queue Queue satisfies it; mirrors surfaces/session.ts and surfaces/slack-inbound.ts.
 */
export interface ResumeProducer {
  insertResumeTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    humanMessageId: string,
  ): Promise<{ jobId: string | null }>;
  publishResume(jobId: string): Promise<void>;
  /**
   * Durable recovery hand-off for a decision that cannot evaluate provider clearance in its own
   * transaction. Without it that contention fails the decision instead.
   */
  insertRecoveryTx?(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    lifecycleVersion: number,
    signalFence: string,
  ): Promise<{ jobId: string | null }>;
  /** Post-commit dispatch for a job `insertRecoveryTx` created. */
  publishJob?(jobId: string): Promise<void>;
}

export interface ApplyApprovalDecisionDeps {
  /** System connection (RLS-bypassing) for the by-PK approval lookup: the approvalId is caller-supplied. */
  adminDb: Db;
  /** RLS-scoped connection for the tenant-scoped CAS + hub append. */
  appDb: Db;
  hub: ConversationHub;
  queue: ResumeProducer;
  /** Best-effort sink for a post-commit fan-out/dispatch failure (the reply + resume are already durable). */
  onError?: (err: unknown, incidentId: string) => void;
}

export interface ApplyApprovalDecisionInput {
  tenantId: string;
  approvalId: string;
  optionId: string;
  /** Who decided: the dashboard user (users.id/sub) or the Slack username/id. */
  decidedBy: string;
  /**
   * The decider as a PRE-RESOLVED platform user id, stamped on the 'decided' reply for attribution.
   * MUST already be proven a member of `tenantId`, or null. The caller owns that guarantee outright:
   * `incident_messages.author_user_id` is a PLAIN FK to `users.id` (users carries no tenant_id, so tenant
   * scoping is RLS, not RI), which means Postgres checks only that the user EXISTS. A wrong-tenant id is
   * ACCEPTED, not rejected, and would attribute a decision to someone in another tenant. Resolve through
   * memberships (`resolveUserByEmail`, or the authed context's `userId`), never from an unvalidated claim.
   * Null when the surface could not resolve exactly one member, so a decision is never credited to the
   * wrong person. Resolve OUTSIDE this function's tx and degrade to null rather than throwing: attribution
   * must never cost the CAS or the resume.
   */
  authorUserId?: string | null;
  /** The surface the decision was made on ('dashboard'/'slack'), stamped for cross-surface echo-suppression. */
  originSurface: string;
  /**
   * Path-scoped incident guard: when the surface addresses the approval under an incident id
   * (the dashboard route's `:id`), the resolved approval MUST belong to it — else `not_found`. Prevents a
   * same-tenant caller from deciding an approval via a mismatched incident path. Omitted by Slack (the
   * callback data carries only the approvalId, no incident path).
   */
  expectedIncidentId?: string;
}

/**
 * Outcome of a decide attempt. `decided` is the CAS winner (append + resume happened); `already_decided`
 * is the idempotent loser (no append, no resume). `not_found` covers a missing OR cross-tenant approval
 * (the tenant guard, never leaking existence); `invalid_option` is an optionId not in the approval.
 */
export type ApprovalDecisionOutcome =
  | { status: 'decided'; label: string }
  | { status: 'already_decided' }
  | { status: 'not_found' }
  | { status: 'invalid_option' };

/**
 * Apply a first-decision-wins approval decision. Resolves the approval by PK, enforces the tenant guard
 * (the caller-supplied approvalId must belong to `tenantId`), resolves the option label, then runs the
 * CAS, the `kind:'reply'` 'decided: <label>' append with `originSurface`, and the coalescing resume job
 * in ONE tenant tx — the CAS rolls back with a failed append or resume, so a decision is never
 * recorded without its resume (no stalled incident). Post-commit dispatch is best-effort (the row + job
 * are already durable). Loser (lost CAS)/miss: no writes.
 */
export async function applyApprovalDecision(
  deps: ApplyApprovalDecisionDeps,
  input: ApplyApprovalDecisionInput,
): Promise<ApprovalDecisionOutcome> {
  const { adminDb, appDb, hub, queue, onError } = deps;
  const {
    tenantId,
    approvalId,
    optionId,
    decidedBy,
    originSurface,
    expectedIncidentId,
    authorUserId,
  } = input;

  if (!UUID_RE.test(approvalId)) return { status: 'not_found' };
  const approval = await getApprovalById(adminDb, approvalId);
  // Cross-tenant guard: the approvalId is attacker-supplied, so the row must belong to THIS tenant. A
  // miss is indistinguishable from a foreign approval by design — no cross-tenant existence oracle.
  if (!approval || approval.tenantId !== tenantId) return { status: 'not_found' };
  // Path-scoped incident guard: when the caller pins an incident id, the approval must be
  // under it — a mismatched (even same-tenant) path is not_found, mirroring the runbook route's check.
  if (expectedIncidentId !== undefined && approval.incidentId !== expectedIncidentId)
    return { status: 'not_found' };

  // Resolve the option by id (not position), so a reordered option list can't decide the wrong one.
  const option = (approval.options as { id: string; label: string }[]).find(
    (o) => o.id === optionId,
  );
  if (!option) return { status: 'invalid_option' };

  // Winner runs the CAS + the 'decided' reply append + the resume-job insert in ONE tenant tx (mirror
  // session.ts): a failed resume rolls the CAS back too, so a decision is never recorded without its
  // resume — no incident stalled forever on a half-applied decision. The loser (CAS returns false) short-
  // circuits the tx with no writes. jobs is non-RLS and app_user holds INSERT, so this app RLS
  // tx writes all three.
  const result = await withTenant(appDb, tenantId, async (tx: Tx) => {
    const won = await decideApprovalTx(
      tx,
      tenantId,
      approval.incidentId,
      approval.actionId,
      option.id,
      decidedBy,
    );
    if (!won) return null;
    // Group work locks before the incident row lock, matching signal writers; the human append
    // below takes the row lock.
    await lockResponseGroupWorkTx(tx, tenantId, approval.incidentId);
    const posted = await hub.appendTx(tx, tenantId, approval.incidentId, {
      author: 'human',
      kind: 'reply',
      content: `decided: ${option.label}`,
      originSurface,
      // attribute the decision to the human who made it, same as a human thread reply. Already
      // resolved by the caller; null when unresolved.
      authorUserId: authorUserId ?? null,
      // link the decided reply to the exact approval it settled, so the dashboard correlates on the
      // id (resolving the option by label WITHIN this approval) instead of scanning for the nearest label
      // match — deterministic when two pending approvals share an option label. Content stays unchanged.
      approvalId: approval.id,
    });
    let recoveryJobId = null as string | null;
    const insertRecoveryTx = queue.insertRecoveryTx?.bind(queue);
    const lifecycleMessages = await hub.completeVerifiedRecoveryAfterApprovalTx(
      tx,
      tenantId,
      approval.incidentId,
      approval.id,
      insertRecoveryTx &&
        (async (recoveryTx, candidate) => {
          recoveryJobId = (
            await insertRecoveryTx(
              recoveryTx,
              tenantId,
              candidate.rootIncidentId,
              candidate.lifecycleVersion,
              candidate.signalFence,
            )
          ).jobId;
          return recoveryJobId;
        }),
    );
    const { jobId } = await queue.insertResumeTx(tx, tenantId, approval.incidentId, posted.id);
    return { appended: posted, lifecycleMessages, resumeJobId: jobId, recoveryJobId };
  });
  if (!result) return { status: 'already_decided' };
  const { appended, lifecycleMessages, resumeJobId, recoveryJobId } = result;
  // Post-commit fan-out + dispatch (Redis is not transactional): the reply + job are already durable, so
  // a failure here is best-effort — history replay + the reconciler recover it, never fail the decision.
  await hub.publishAppended(appended).catch((err) => onError?.(err, approval.incidentId));
  for (const lifecycleMessage of lifecycleMessages)
    await hub
      .publishAppended(lifecycleMessage)
      .catch((err) => onError?.(err, lifecycleMessage.incidentId));
  if (resumeJobId)
    await queue.publishResume(resumeJobId).catch((err) => onError?.(err, approval.incidentId));
  if (recoveryJobId)
    await queue.publishJob?.(recoveryJobId).catch((err) => onError?.(err, approval.incidentId));
  return { status: 'decided', label: option.label };
}
