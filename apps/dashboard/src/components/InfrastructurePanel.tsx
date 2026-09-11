import { useMemo } from 'react';
import { useSession } from '../auth';
import { config } from '../config';
import { useInfrastructure } from '../lib/useInfrastructure';
import { InfrastructureList } from './InfrastructureList';
import { PageHeader } from './PageHeader';
import { InlineAlert, StatePanel } from './PageState';
import { infrastructureHealth } from '../lib/infrastructure';
import { declareInvestigation, type InvestigationSubject } from '../lib/investigations';
import { useInvestigationWorkspaces } from '../lib/useInvestigationWorkspaces';

/** The Infrastructure panel: normalized connector snapshots grouped by source, with staleness/error flags. */
export function InfrastructurePanel() {
  const { getCredentials } = useSession();
  const { snapshots, loading, error, errorStatus, backgroundError } = useInfrastructure({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
  });
  const blockingError = error && !backgroundError;
  const accessDenied = blockingError && errorStatus === 403;
  const subjects = useMemo<InvestigationSubject[]>(
    () =>
      snapshots
        .filter((snapshot) => infrastructureHealth(snapshot, Date.now()) !== 'healthy')
        .map((snapshot) => ({
          kind: 'infrastructure_resource',
          dataSourceId: snapshot.dataSourceId,
          entityId: snapshot.entityId,
        })),
    [snapshots],
  );
  const activeInvestigations = useInvestigationWorkspaces({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    subjects,
  });

  return (
    <section>
      <PageHeader title="Infrastructure" />
      {loading && !blockingError && (
        <StatePanel state="loading" title="Loading infrastructure…" skeleton="table" />
      )}
      {blockingError && (
        <StatePanel
          state={accessDenied ? 'access' : 'error'}
          title={accessDenied ? 'No tenant access.' : 'Failed to load infrastructure.'}
          description={
            accessDenied
              ? 'This signed-in account must be assigned to exactly one tenant. Use an account with tenant access or ask an administrator to assign it.'
              : 'Infrastructure snapshots could not be retrieved. The page will retry automatically.'
          }
        />
      )}
      {!loading && backgroundError && (
        <InlineAlert message="Live refresh failed. Showing the last successful infrastructure snapshot." />
      )}
      {!loading && !blockingError && (
        <InfrastructureList
          snapshots={snapshots}
          activeInvestigations={activeInvestigations}
          declareInvestigation={(subject) =>
            declareInvestigation(config.apiBaseUrl, getCredentials, subject)
          }
        />
      )}
    </section>
  );
}
