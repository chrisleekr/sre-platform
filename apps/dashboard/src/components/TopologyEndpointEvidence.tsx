import { useEffect, useRef, useState } from 'react';
import type { TopologyEndpointEvidence as EndpointEvidence } from '@sre/contracts';
import { authenticatedFetch } from '../lib/authenticatedFetch';
import { checkResponse } from '../lib/request-error';
import { formatAbsoluteTime } from '../lib/time';
import { incidentPath } from '../lib/routes';
import type { TopologyAccess } from './TopologySubjectImpact';

/** Show audited probe observations without issuing requests to the endpoint from the dashboard. */
export function TopologyEndpointEvidence({
  subjectKey,
  access,
}: {
  subjectKey: string;
  access: TopologyAccess;
}) {
  const [data, setData] = useState<EndpointEvidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState(false);
  const credentials = useRef(access.getCredentials);
  credentials.current = access.getCredentials;
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPending(true);
    setError(null);
    void authenticatedFetch(
      `${access.apiBaseUrl}/topology/endpoint-evidence?subjectKey=${encodeURIComponent(subjectKey)}`,
      credentials.current,
    )
      .then(async (response) => {
        await checkResponse(
          response,
          'Could not read endpoint evidence. Retry the evidence lookup.',
        );
        const result = (await response.json()) as EndpointEvidence;
        if (active) setData(result);
      })
      .catch((cause: unknown) => {
        if (active) {
          setData(null);
          setError(cause instanceof Error ? cause.message : 'Endpoint evidence is unavailable.');
        }
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
  }, [subjectKey, access.apiBaseUrl, revision]);
  return (
    <section aria-label="Endpoint probe evidence" className="border-b border-line pb-4">
      <div className="flex flex-wrap justify-between gap-2">
        <h4 className="text-sm font-semibold">Endpoint probe evidence</h4>
        <button
          type="button"
          disabled={pending}
          onClick={() => setRevision((value) => value + 1)}
          className="text-xs text-info underline disabled:opacity-50"
        >
          {pending ? 'Reading…' : 'Refresh evidence'}
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        Recorded during investigations. Viewing or refreshing this section does not send a network
        probe.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-warning">
          {error}
        </p>
      )}
      {data && (
        <>
          <p className="mt-2 text-xs text-ink-muted">{data.note}</p>
          <ul className="mt-3 space-y-3" aria-label="Recorded endpoint probes">
            {data.probes.map((probe) => (
              <li key={probe.evidenceId} className="rounded border border-line p-3 text-xs">
                <div className="flex flex-wrap justify-between gap-2">
                  <strong>{probe.kind.toUpperCase()}</strong>
                  <span className="text-ink-muted">
                    {probe.state === 'unavailable'
                      ? 'Probe unavailable'
                      : probe.stale
                        ? 'Stale observation'
                        : 'Recorded observation'}
                  </span>
                </div>
                <dl className="mt-2 grid gap-1">
                  {Object.entries(probe.facts).map(([label, value]) => (
                    <div key={label} className="flex flex-wrap justify-between gap-2">
                      <dt className="text-ink-muted">
                        {
                          {
                            addresses: 'Resolved addresses',
                            reachable: 'TCP reachable',
                            latencyMs: 'Latency (ms)',
                            authorized: 'TLS trusted',
                            expiresAt: 'Certificate expiry',
                            status: 'HTTP status',
                          }[label]
                        }
                      </dt>
                      <dd className="break-all font-instrument">
                        {Array.isArray(value)
                          ? value.join(', ')
                          : typeof value === 'boolean'
                            ? value
                              ? 'Yes'
                              : 'No'
                            : label === 'expiresAt'
                              ? formatAbsoluteTime(String(value))
                              : String(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-2 text-ink-muted">{formatAbsoluteTime(probe.observedAt)}</p>
                <a
                  className="mt-1 inline-block text-info underline"
                  href={incidentPath(probe.incidentId)}
                >
                  Open source investigation
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
