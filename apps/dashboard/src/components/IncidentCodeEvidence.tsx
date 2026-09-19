import type { EvidenceDetail } from '../lib/types';
import { IncidentEvidenceText } from './IncidentEvidenceText';

type CodeProjection = Extract<EvidenceDetail['projection'], { kind: 'code' }>;

const shortRevision = (revision: string | null): string =>
  revision ? revision.slice(0, 12) : 'revision unavailable';

const label = (value: string): string => value.replaceAll('_', ' ');

function ProviderLink({ href, children }: { href: string | null; children: string }) {
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-semibold text-accent underline"
    >
      {children} ↗
    </a>
  ) : null;
}

export function IncidentCodeEvidence({ projection }: { projection: CodeProjection }) {
  return (
    <section className="@container min-w-0 space-y-4" aria-labelledby="code-evidence-title">
      <div className="rounded-md border border-assessment-line bg-assessment-soft p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-assessment">
          Code intelligence
        </p>
        <h4 id="code-evidence-title" className="mt-1 font-semibold text-ink">
          {projection.status === 'located'
            ? `${projection.matches.length} source ${projection.matches.length === 1 ? 'location' : 'locations'} found`
            : label(projection.status)}
        </h4>
      </div>

      {projection.artifacts.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Running artifacts
          </h4>
          <ul className="mt-2 space-y-2 text-xs">
            {projection.artifacts.map((artifact, index) => (
              <li
                key={`${artifact.dataSourceName}:${artifact.namespace}:${artifact.workload}:${artifact.container}:${index}`}
                className="rounded-md border border-line p-2"
              >
                <p className="font-semibold text-ink-secondary">
                  {artifact.namespace}/{artifact.workload ?? 'unknown workload'} ·{' '}
                  {artifact.container}
                </p>
                <p className="mt-1 break-all font-instrument text-ink-muted">{artifact.identity}</p>
                <p className="mt-1 text-ink-muted">
                  {artifact.dataSourceName}
                  {artifact.revision ? ` · source ${shortRevision(artifact.revision)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {projection.revisions.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Repository provenance
          </h4>
          <ul className="mt-2 grid min-w-0 gap-2 @xl:grid-cols-2">
            {projection.revisions.map((revision, index) => (
              <li
                key={`${revision.repository}:${revision.revision}:${index}`}
                className="rounded-md border border-line p-3 text-xs"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="break-words font-semibold text-ink">{revision.repository}</p>
                  <span className="rounded-full bg-surface-strong px-2 py-0.5 font-semibold text-ink-secondary">
                    {label(revision.strength)}
                  </span>
                </div>
                <p className="mt-1 font-instrument text-ink-secondary">
                  {shortRevision(revision.revision)}
                </p>
                <p className="mt-1 text-ink-muted">
                  {label(revision.role)} · {label(revision.basis)}
                </p>
                {revision.deployedAt && (
                  <p className="mt-1 text-ink-muted">{revision.deployedAt}</p>
                )}
                <p className="mt-2">
                  <ProviderLink href={revision.providerUrl}>Open revision</ProviderLink>
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {projection.matches.map((match, index) => (
        <article
          key={`${match.repository}:${match.revision}:${match.path}:${index}`}
          className="rounded-md border border-line-strong"
        >
          <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line bg-surface-subtle p-3">
            <div className="min-w-0">
              <p className="break-words font-semibold text-ink">{match.repository}</p>
              <p className="mt-1 break-all font-instrument text-xs text-ink-secondary">
                {match.path}:{match.startLine}-{match.endLine} · {shortRevision(match.revision)}
              </p>
            </div>
            <div className="flex flex-wrap gap-1 text-xs">
              <span className="rounded-full bg-assessment-muted px-2 py-0.5 font-semibold text-assessment">
                {label(match.strength)}
              </span>
              {match.changedFromPreviousRevision === true && (
                <span className="rounded-full bg-warning-muted px-2 py-0.5 font-semibold text-warning">
                  changed in deploy
                </span>
              )}
            </div>
            <ProviderLink href={match.providerUrl}>Open exact source</ProviderLink>
          </header>
          <IncidentEvidenceText text={match.excerpt} label="Code" />
        </article>
      ))}

      {projection.matches.length > 0 && (
        <p className="rounded-md border border-line bg-surface-subtle p-3 text-xs text-ink-muted">
          A source location shows where the failing path executes. It is not root-cause proof
          without matching runtime, timing, and behaviour evidence.
        </p>
      )}

      {(projection.uncertainties.length > 0 || projection.requiredSetup.length > 0) && (
        <div className="rounded-md border border-warning-line bg-warning-soft p-3 text-xs text-warning">
          {projection.uncertainties.length > 0 && (
            <>
              <h4 className="font-semibold">Uncertainty</h4>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {projection.uncertainties.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {projection.requiredSetup.length > 0 && (
            <>
              <h4 className="mt-3 font-semibold">Required setup</h4>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {projection.requiredSetup.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
