interface IncidentFreeStatusBase {
  scope: { severities: readonly ['sev1', 'sev2'] };
  lastIncident: { id: string; title: string | null; severity: string } | null;
}

export type IncidentFreeStatus =
  | (IncidentFreeStatusBase & {
      state: 'running';
      asOf: string;
      startedAt: string;
      qualifyingActiveCount: 0;
    })
  | (IncidentFreeStatusBase & {
      state: 'paused';
      asOf: string;
      startedAt: null;
      qualifyingActiveCount: number;
    })
  | (IncidentFreeStatusBase & {
      state: 'never_observed';
      asOf: string;
      startedAt: null;
      qualifyingActiveCount: 0;
    })
  | (IncidentFreeStatusBase & {
      state: 'unavailable';
      asOf: string | null;
      startedAt: null;
      qualifyingActiveCount: 0;
    });
