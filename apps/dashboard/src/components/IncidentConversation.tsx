import { Link, useParams } from 'react-router-dom';
import { useSession } from '../auth';
import { config } from '../config';
import { incidentDisplayTitle } from '../lib/incidentTitle';
import { productPath } from '../lib/routes';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { useIncidentWorkspace } from '../lib/useIncidentWorkspace';
import { PageHeader } from './PageHeader';
import { StatePanel } from './PageState';
import { LiveIncidentConversation } from './incident-conversation/live';
import { IssueManagement } from './IssueManagement';

export { lifecycleActions, signalTargets } from './incident-conversation/signals';
export { ConversationLog, alignFor, messageText } from './incident-conversation/timeline';

export function IncidentConversation() {
  const { id } = useParams();
  const { getCredentials, user } = useSession();
  const incidentId = id ?? '';
  const { workspace, loading, error, refresh } = useIncidentWorkspace(incidentId, {
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
  });
  // A live message refreshes the assessment. Keep the mounted transcript and socket alive while that
  // request runs; unmounting here would reconnect, replay the latest message, and refresh forever.
  // Never retain a previous route's workspace while the next incident is loading.
  const currentWorkspace = workspace?.incident.id === incidentId ? workspace : null;
  useDocumentTitle(
    currentWorkspace
      ? `${currentWorkspace.incident.severity.toUpperCase()} · ${incidentDisplayTitle(currentWorkspace.incident, currentWorkspace.signals)}`
      : 'Incident',
  );

  return (
    <section className="min-h-full min-w-0 overflow-x-hidden">
      <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Link to={productPath()} className="font-medium text-ink-muted hover:text-ink">
          Dashboard
        </Link>
        <span aria-hidden="true" className="text-ink-faint">
          /
        </span>
        <Link to={productPath('incidents')} className="font-medium text-ink-muted hover:text-ink">
          Incidents
        </Link>
        <span aria-hidden="true" className="text-ink-faint">
          /
        </span>
        <span aria-current="page" className="text-ink-muted">
          Incident
        </span>
        {currentWorkspace && (
          <IssueManagement
            incidentId={incidentId}
            apiBaseUrl={config.apiBaseUrl}
            getCredentials={getCredentials}
          />
        )}
      </nav>
      {!currentWorkspace && (loading || error) && <PageHeader title="Incident" />}
      {!currentWorkspace && loading && (
        <StatePanel state="loading" title="Loading incident…" skeleton="detail" />
      )}
      {!currentWorkspace && !loading && error === 'not-found' && (
        <StatePanel
          state="empty"
          title="Incident not found."
          description="The incident does not exist or is not available to this tenant."
        />
      )}
      {!currentWorkspace && !loading && error === 'load-error' && (
        <StatePanel
          state="error"
          title="Failed to load incident."
          description="The incident details could not be retrieved."
          onRetry={refresh}
        />
      )}
      {currentWorkspace && (
        <LiveIncidentConversation
          key={currentWorkspace.incident.id}
          workspace={currentWorkspace}
          viewerName={user?.name ?? user?.email}
          getCredentials={getCredentials}
          refreshWorkspace={refresh}
        />
      )}
    </section>
  );
}
