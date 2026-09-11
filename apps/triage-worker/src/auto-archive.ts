// The scheduler is best-effort per tenant. It deletes only settled terminal incidents through the
// audited tombstone command, so inactivity can never hide live operational work.

const DAY_MS = 24 * 60 * 60_000;

export interface ConfiguredAutoArchiveDeps {
  getArchiveDays: () => Promise<number>;
  sweep: (idleBefore: Date) => Promise<number>;
  now?: () => number;
}

/** Read the live policy for each scheduled run; zero disables the sweep without touching tenant data. */
export async function runConfiguredAutoArchiveSweep(
  deps: ConfiguredAutoArchiveDeps,
): Promise<{ archiveDays: number; archived: number; idleBefore: Date | null }> {
  const archiveDays = await deps.getArchiveDays();
  if (archiveDays === 0) return { archiveDays, archived: 0, idleBefore: null };
  const idleBefore = new Date((deps.now ?? Date.now)() - archiveDays * DAY_MS);
  return { archiveDays, archived: await deps.sweep(idleBefore), idleBefore };
}

export interface AutoArchiveSweepDeps {
  /** All tenants (SYSTEM-level enumeration; the writer scopes each deletion under RLS). */
  listTenants: () => Promise<{ id: string }[]>;
  /** Delete idle terminal incidents for one tenant; returns the number deleted. */
  archiveIdle: (tenantId: string) => Promise<number>;
  /** Best-effort error sink for a per-tenant failure. */
  onError?: (err: unknown, ctx: { tenantId: string }) => void;
}

export interface AuditedAutoArchiveDeps {
  listIdle: (
    tenantId: string,
    idleBefore: Date,
  ) => Promise<Array<{ id: string; lifecycleVersion: number }>>;
  archive: (
    tenantId: string,
    incidentId: string,
    input: {
      archived: true;
      reason: string;
      archiveKey: string;
      author: 'system';
      expectedVersion: number;
      idleBefore: Date;
    },
  ) => Promise<{ outcome: string }>;
}

/** Delete idle terminal cases through the same audited tombstone path as a responder. */
export async function archiveIdleTerminalIncidents(
  deps: AuditedAutoArchiveDeps,
  tenantId: string,
  idleBefore: Date,
): Promise<number> {
  const candidates = await deps.listIdle(tenantId, idleBefore);
  let archived = 0;
  for (const candidate of candidates) {
    const result = await deps.archive(tenantId, candidate.id, {
      archived: true,
      reason: 'Automatically deleted after the terminal incident remained inactive.',
      archiveKey: `idle-archive:${candidate.id}:${candidate.lifecycleVersion}:${idleBefore.toISOString()}`,
      author: 'system',
      expectedVersion: candidate.lifecycleVersion,
      idleBefore,
    });
    if (result.outcome === 'applied') archived++;
  }
  return archived;
}

/** Sweep every tenant without allowing one tenant failure to block the others. */
export async function runAutoArchiveSweep(deps: AutoArchiveSweepDeps): Promise<number> {
  let archived = 0;
  const tenants = await deps.listTenants();
  for (const { id: tenantId } of tenants) {
    try {
      archived += await deps.archiveIdle(tenantId);
    } catch (err) {
      deps.onError?.(err, { tenantId });
    }
  }
  return archived;
}
