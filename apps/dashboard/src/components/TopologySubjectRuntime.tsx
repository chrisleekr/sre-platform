import { useEffect, useRef, useState } from 'react';
import type { TopologyRuntimeEvidence, TopologySubject } from '@sre/contracts';
import { authenticatedFetch } from '../lib/authenticatedFetch';
import { checkResponse } from '../lib/request-error';
import {
  declareInvestigation,
  investigationSubjectKey,
  type InvestigationSubject,
} from '../lib/investigations';
import { useInvestigationWorkspaces } from '../lib/useInvestigationWorkspaces';
import type { TopologyAccess } from './TopologySubjectImpact';
import { TopologyEvidenceSources } from './TopologyEvidence';
import { InvestigationAction } from './InvestigationAction';

/** Show exact resource observations without promoting sampled coverage to service health. */
export function TopologySubjectRuntime({
  subject,
  access,
}: {
  subject: TopologySubject;
  access: TopologyAccess;
}) {
  const [result, setResult] = useState<{
    key: string;
    data?: TopologyRuntimeEvidence;
    error?: string;
  } | null>(null);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const credentials = useRef(access.getCredentials);
  credentials.current = access.getCredentials;
  const key = JSON.stringify([access.apiBaseUrl, subject.key]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPending(true);
    void authenticatedFetch(
      `${access.apiBaseUrl}/topology/runtime?subjectKey=${encodeURIComponent(subject.key)}`,
      credentials.current,
    )
      .then(async (response) => {
        await checkResponse(
          response,
          'Could not load runtime observations. Retry to check the current state.',
        );
        const data = (await response.json()) as TopologyRuntimeEvidence;
        if (active) setResult({ key, data });
      })
      .catch((error: unknown) => {
        if (active)
          setResult({
            key,
            error: error instanceof Error ? error.message : 'Runtime observations are unavailable.',
          });
      })
      .finally(() => {
        if (active) {
          setPending(false);
          timer = setTimeout(() => setRevision((value) => value + 1), 30_000);
        }
      });
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key, revision, subject.key, access.apiBaseUrl]);
  const data = result?.key === key ? result.data : undefined;
  const error = result?.key === key ? result.error : undefined;
  const unhealthy =
    data?.observations.filter((row) => !row.stale && row.state === 'attention') ?? [];
  const uncertain =
    data?.observations.filter((row) => row.stale || row.state === 'unknown').length ?? 0;
  const investigation: InvestigationSubject = {
    kind: 'topology_service',
    service: subject.name,
    subjectKey: subject.key,
  };
  const active = useInvestigationWorkspaces({
    ...access,
    subjects: subject.kind === 'service' ? [investigation] : [],
  });
  const activeIncidentId = active.get(investigationSubjectKey(investigation));
  return (
    <section aria-label="Observed runtime" className="border-b border-line pb-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Observed runtime</h4>
        <button
          type="button"
          disabled={pending}
          onClick={() => setRevision((value) => value + 1)}
          className="text-xs text-info underline disabled:opacity-50"
        >
          {pending ? 'Checking…' : 'Refresh runtime'}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-warning">
          {error}
        </p>
      )}
      {!data && !error && (
        <p role="status" className="mt-2 text-sm text-ink-muted">
          Checking associated resources…
        </p>
      )}
      {data && (
        <>
          <p className="mt-2 text-sm text-ink-muted">
            {data.observations.length
              ? `${
                  unhealthy.length
                    ? `${unhealthy.length} of ${data.observations.length} observed resources need attention.`
                    : uncertain
                      ? 'No current issues confirmed. Some resource observations are stale or unknown.'
                      : 'No observed resources need attention.'
                } Coverage is partial, not an overall service health assessment.`
              : 'No current runtime observations match this subject. Check its connections and refresh after the next collection.'}
          </p>
          {pending && (
            <p className="mt-1 text-xs text-ink-muted">Showing the last result while refreshing.</p>
          )}
          <ul
            className="mt-3 max-h-64 space-y-3 overflow-y-auto"
            aria-label="Runtime resource observations"
          >
            {data.observations.map((row) => (
              <li key={row.resourceKey} className="rounded-md border border-line p-3 text-xs">
                <div className="flex flex-wrap justify-between gap-2">
                  <strong className="break-all">{row.name}</strong>
                  <span className={row.state === 'attention' ? 'text-warning' : 'text-ink-muted'}>
                    {row.stale
                      ? 'Stale observation'
                      : row.state === 'attention'
                        ? 'Needs attention'
                        : row.state === 'healthy'
                          ? 'Resource healthy'
                          : 'State unknown'}
                  </span>
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-info">Observation evidence</summary>
                  <div className="mt-2">
                    <TopologyEvidenceSources sources={row.sources} />
                  </div>
                </details>
              </li>
            ))}
          </ul>
          <details className="mt-2 text-xs text-ink-muted">
            <summary className="cursor-pointer">Coverage limits</summary>
            <p className="mt-2">{data.note}</p>
          </details>
        </>
      )}
      {subject.kind === 'service' &&
        (activeIncidentId || (!pending && !error && unhealthy.length > 0)) && (
          <div className="mt-3">
            <InvestigationAction
              subject={investigation}
              activeIncidentId={activeIncidentId}
              preview={{
                title: `${subject.name} observed runtime needs attention`,
                source: 'Identity-matched runtime observations',
                condition: `${unhealthy.length} observed resources need attention. Service coverage is incomplete.`,
                severity: 'SEV3',
              }}
              declareInvestigation={(value) =>
                declareInvestigation(access.apiBaseUrl, access.getCredentials, value)
              }
            />
          </div>
        )}
    </section>
  );
}
