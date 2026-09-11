import { adminActions } from '../schema';
import type { Tx } from '../rls';

export type AdminMutationCode =
  'conflict' | 'invalid_target' | 'last_admin' | 'last_owner' | 'not_found';

/** Stable refusal raised by a platform-administrator mutation. */
export class AdminMutationError extends Error {
  constructor(
    readonly code: AdminMutationCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdminMutationError';
  }
}

export interface AdminActionInput {
  actorUserId: string;
  action: string;
  targetKind: string;
  targetId: string;
  reason?: string;
  details?: Record<string, unknown>;
}

/**
 * Appends the audit row inside the caller's mutation transaction.
 *
 * @param tx - Transaction that owns the administrator mutation.
 * @param input - Actor, action, target, reason, and structured details.
 */
export async function appendAdminAction(tx: Tx, input: AdminActionInput): Promise<string> {
  const [action] = await tx
    .insert(adminActions)
    .values({
      ...input,
      reason: input.reason ?? null,
      details: input.details ?? {},
    })
    .returning({ id: adminActions.id });
  if (!action) throw new Error('administrator audit insert returned no row');
  return action.id;
}
