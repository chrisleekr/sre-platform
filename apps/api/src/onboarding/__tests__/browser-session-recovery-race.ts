import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '@sre/db';

/** Changes one duplicate founding immediately after its recovered session is inserted. */
export async function withFoundingRetirementRace<T>(
  db: Db,
  input: { providerId: string; foundingId: string },
  run: () => Promise<T>,
): Promise<T> {
  const name = `recovery_race_${randomUUID().replaceAll('-', '')}`;
  await db.execute(
    sql.raw(`
      create function ${name}() returns trigger language plpgsql as $$
      begin
        if new.provider_id = '${input.providerId}'::uuid then
          update workspace_foundings set status = 'pending'
          where id = '${input.foundingId}'::uuid;
        end if;
        return new;
      end $$
    `),
  );
  await db.execute(
    sql.raw(`create trigger ${name} after insert on browser_sessions
      for each row execute function ${name}()`),
  );
  try {
    return await run();
  } finally {
    await db.execute(sql.raw(`drop trigger ${name} on browser_sessions`));
    await db.execute(sql.raw(`drop function ${name}()`));
  }
}
