import { sql } from 'drizzle-orm';
import type { Db } from './client';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Anything a repo can run on: a pooled connection (opens its own tx) or an already-open tenant tx. */
export type Executor = Db | Tx;

/** A `PgTransaction` carries `rollback`; a `PgDatabase` does not. The only structural discriminator. */
const isTx = (exec: Executor): exec is Tx => 'rollback' in exec;

/**
 * The tenant a transaction has already been bound to. Module-private (a `Symbol`, not a string key) so
 * nothing outside this file can set, read, or forge it.
 */
const BOUND_TENANT = Symbol('sre.boundTenant');
type Branded = { [BOUND_TENANT]?: string };

/**
 * Runs an operation in a transaction scoped to one tenant.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param fn - Value supplied for fn.
 */
export async function withTenant<T>(
  exec: Executor,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (isTx(exec)) {
    const bound = (exec as Tx & Branded)[BOUND_TENANT];
    if (bound !== undefined && bound !== tenantId) {
      throw new Error(
        `withTenant: transaction is bound to tenant ${bound}; refusing to rebind to ${tenantId}`,
      );
    }
    if (bound === undefined) await bind(exec, tenantId);
    return fn(exec);
  }
  return exec.transaction(async (tx) => {
    await bind(tx, tenantId);
    return fn(tx);
  });
}

/** Set the transaction-scoped RLS tenant and brand the tx with it. */
async function bind(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
  (tx as Tx & Branded)[BOUND_TENANT] = tenantId;
}
