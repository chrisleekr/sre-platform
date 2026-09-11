import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema';

export type Schema = typeof schema;
export type Db = PostgresJsDatabase<Schema>;

export interface DbHandle {
  db: Db;
  sql: Sql;
  close: () => Promise<void>;
}

/**
 * Builds the application database client.
 *
 * @param url - Value supplied for url.
 */
export function makeDb(url: string): DbHandle {
  const sql = postgres(url, { max: 5 });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}
