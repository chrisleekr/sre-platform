import type { Db } from './client';
import { tenants } from './schema';

/**
 * Lists tenants.
 *
 * @param db - Database connection used for the operation.
 */
export function listTenants(db: Db): Promise<{ id: string }[]> {
  return db.select({ id: tenants.id }).from(tenants);
}
