import {
  meaningfulIncidentTitle,
  scrubSecrets,
  openingIncidentTitle,
  type IncidentTitlePresentation,
} from '@sre/contracts';
import { sql } from 'drizzle-orm';
import type { Db } from '../client';
import { withTenant } from '../rls';

interface OpeningRow extends Record<string, unknown> {
  incidentId: string;
  author: string;
  kind: string;
  content: string;
  origin: string | null;
  createdAt: string;
  lifecycleVersion: number | null;
  signalId: string | null;
}

/** Add display-only descriptions from a bounded, tenant-scoped opening cohort.
 * @param db - Application database using tenant RLS.
 * @param tenantId - Tenant that owns the selected incidents.
 * @param selected - Already selected public incident page, never correlation candidates.
 */
export async function presentIncidentTitles<T extends { id: string; title: string | null }>(
  db: Db,
  tenantId: string,
  selected: T[],
): Promise<Array<T & IncidentTitlePresentation>> {
  const missing = selected.filter((item) => !meaningfulIncidentTitle(item.title));
  let rows: OpeningRow[] = [];
  if (missing.length) {
    rows = await withTenant(db, tenantId, async (tx) => [
      ...(await tx.execute<OpeningRow>(sql`
      select i.id as "incidentId", m.author, m.kind, m.content, m.origin_message_id as origin,
        m.created_at::text as "createdAt", m.lifecycle_version as "lifecycleVersion", m.signal_id as "signalId"
      from incidents i
      cross join lateral (
        select author, kind,
          case
            when origin_message_id like 'thread-context:%' then left(content, 8192)
            when author = 'human' or (kind = 'signal' and signal_id is not null) then left(content, 2048)
            else ''
          end as content,
          id, origin_message_id, created_at, lifecycle_version, signal_id
        from incident_messages
        where tenant_id = ${tenantId} and incident_id = i.id
        order by created_at, id limit 8
      ) m
      where i.tenant_id = ${tenantId} and i.id in (${sql.join(
        missing.map((item) => sql`${item.id}::uuid`),
        sql`, `,
      )})
      order by i.id, m.created_at, m.id
    `)),
    ]);
  }
  return selected.map((original) => {
    const item = {
      ...original,
      title: original.title ? scrubSecrets(original.title) : original.title,
    };
    const stored = meaningfulIncidentTitle(item.title);
    if (stored) return { ...item, displayTitle: stored, titleSource: 'stored' as const };
    const cohort = rows.filter((row) => row.incidentId === item.id);
    const opening = cohort.find((row) => row.kind === 'lifecycle' && row.lifecycleVersion === 0);
    const alert = opening
      ? cohort.find(
          (row) => row.createdAt === opening.createdAt && row.kind === 'signal' && row.signalId,
        )
      : undefined;
    const alertTitle =
      alert && !['[', '{'].includes(alert.content.trim()[0] ?? '')
        ? meaningfulIncidentTitle(alert.content)
        : null;
    if (alertTitle)
      return { ...item, displayTitle: alertTitle, titleSource: 'linked_alert' as const };
    const opener = opening
      ? cohort.find(
          (row) =>
            row.createdAt === opening.createdAt &&
            row.author === 'human' &&
            row.origin &&
            !row.origin.startsWith('thread-context:'),
        )
      : undefined;
    if (opener) {
      const context = cohort.find((row) => row.origin === `thread-context:${opener.origin}`);
      return { ...item, ...openingIncidentTitle(opener.content, context?.content ?? '') };
    }
    const legacy = cohort
      .slice(0, 2)
      .find(
        (row) =>
          row.author === 'human' &&
          row.content.startsWith('Human-initiated via @mention. Prior thread:\n'),
      );
    if (legacy)
      return {
        ...item,
        ...openingIncidentTitle(
          '',
          legacy.content.slice('Human-initiated via @mention. Prior thread:\n'.length),
        ),
      };
    return {
      ...item,
      displayTitle: 'Opening context unavailable',
      titleSource: 'unavailable' as const,
    };
  });
}
