import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { TopologyRelationKind, TopologySubject } from '@sre/contracts';
import type { TopologyDiscoveryGraph } from '../lib/topology';
import { TopologyEvidenceSources, evidenceLabels } from './TopologyEvidence';

const relationLabels: Record<TopologyRelationKind, string> = {
  owns: 'owns',
  manages: 'manages',
  routes_to: 'routes to',
  deployed_from: 'deployed from',
  declared_in: 'declared in',
  monitors: 'monitors',
  calls: 'calls',
  depends_on: 'depends on',
  runs_on: 'runs on',
  reads_from: 'reads from',
};

function groupEvidence(facts: TopologyDiscoveryGraph['relations']) {
  const groups = new Map<string, TopologyDiscoveryGraph['relations']>();
  for (const fact of facts) {
    const key = JSON.stringify([
      fact.kind,
      fact.evidence,
      fact.description,
      fact.scope,
      fact.attributes,
      fact.stale,
      fact.sources.map((source) => JSON.stringify(source)).sort(),
    ]);
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }
  return [...groups.entries()];
}

/** A focused, directional neighbourhood keeps provider relationships distinct from service calls. */
export function TopologySubjectDetail({
  graph,
  subject,
  onSelect,
  onBack,
  impact,
  runtime,
  preserveMap = false,
}: {
  graph: TopologyDiscoveryGraph;
  subject: TopologySubject;
  onSelect: (key: string) => void;
  onBack: () => void;
  impact?: ReactNode;
  runtime?: ReactNode;
  preserveMap?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: preserveMap && window.innerWidth >= 1024 });
  }, [subject.key]);
  const [relationLimit, setRelationLimit] = useState(20);
  const [resourceLimit, setResourceLimit] = useState(20);
  const subjects = new Map(graph.operational.subjects.map((item) => [item.key, item]));
  const resources = new Set([subject.key, ...subject.resourceKeys]);
  const entities = graph.entities.filter(
    (entity) => resources.has(entity.key) && entity.kind !== 'service',
  );
  const relations = graph.operational.relations.filter(
    (relation) => relation.from === subject.key || relation.to === subject.key,
  );
  const evidence = new Map(graph.relations.map((relation) => [relation.key, relation]));
  const unresolved = graph.relations.filter(
    (relation) =>
      (!relation.fromKey || !relation.toKey) &&
      (resources.has(relation.fromKey ?? '') || resources.has(relation.toKey ?? '')),
  );
  return (
    <section
      className="min-w-0 rounded-lg border border-line bg-surface"
      aria-label="Selected topology subject"
    >
      <header className="border-b border-line bg-surface-subtle p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{subject.kind}</p>
        <h3 ref={heading} tabIndex={-1} className="mt-1 break-words text-xl font-semibold">
          {subject.name}
        </h3>
        <button type="button" onClick={onBack} className="mt-2 text-xs text-info underline">
          Back to results
        </button>
        <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs">
          {Object.entries(subject.scope).map(([key, value]) => (
            <div key={key} className="min-w-0">
              <dt className="text-ink-muted">{key}</dt>
              <dd className="break-all font-instrument">{value}</dd>
            </div>
          ))}
        </dl>
        <p className={`mt-3 text-xs ${subject.stale ? 'text-warning' : 'text-ink-muted'}`}>
          {subject.stale
            ? 'Evidence is stale or the source is unavailable.'
            : 'Recent discovery evidence. This is not a service health assessment.'}
        </p>
      </header>
      <div className="space-y-5 p-4">
        {subject.identityConflict && (
          <p role="alert" className="text-sm text-warning">
            Sources disagree about this identity. It cannot be used for impact analysis until the
            conflicting evidence is resolved.
          </p>
        )}
        {runtime}
        {impact}
        <div>
          <h4 className="text-sm font-semibold">Relationships · {relations.length}</h4>
          <p className="mt-1 text-xs text-ink-muted">
            Read each relationship from left to right. A route, deployment or monitor is not
            evidence of a service call.
          </p>
          {relations.length === 0 && (
            <p className="mt-4 text-sm text-ink-muted">
              No resolved relationships have been collected for this subject yet.
            </p>
          )}
          <ul className="mt-3 space-y-2" aria-label="Subject relationships">
            {relations.slice(0, relationLimit).map((relation) => {
              const otherKey = relation.from === subject.key ? relation.to : relation.from;
              const other = subjects.get(otherKey);
              if (!other) return null;
              const related = (
                <button
                  type="button"
                  onClick={() => onSelect(otherKey)}
                  className="break-words text-left font-semibold text-info underline decoration-info-line underline-offset-4"
                >
                  {other.name}
                </button>
              );
              return (
                <li
                  key={JSON.stringify([
                    relation.from,
                    relation.to,
                    relation.kind,
                    relation.evidence,
                  ])}
                  className="min-w-0 rounded-md border border-line p-3"
                >
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                    {relation.from === subject.key ? (
                      <strong className="break-words">{subject.name}</strong>
                    ) : (
                      related
                    )}
                    <span className="text-ink-muted">→ {relationLabels[relation.kind]} →</span>
                    {relation.to === subject.key ? (
                      <strong className="break-words">{subject.name}</strong>
                    ) : (
                      related
                    )}
                  </div>
                  <p className="mt-1 break-words text-xs text-ink-muted">
                    {other.kind} ·{' '}
                    {Object.entries(other.scope)
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(' · ') || 'Scope not reported'}
                  </p>
                  <details className="mt-3 text-xs">
                    <summary className="cursor-pointer text-info">
                      {evidenceLabels[relation.evidence]} ·{' '}
                      {relation.stale ? 'Stale evidence' : 'Inspect evidence'}
                    </summary>
                    <ul className="mt-2 space-y-3">
                      {groupEvidence(
                        relation.evidenceKeys.flatMap((key) => {
                          const fact = evidence.get(key);
                          return fact ? [fact] : [];
                        }),
                      ).map(([key, facts]) => {
                        const fact = facts[0]!;
                        return (
                          fact && (
                            <li key={key}>
                              <p className="mb-1 break-words">{fact.description}</p>
                              {(fact.kind === 'deployed_from' || fact.kind === 'declared_in') && (
                                <dl className="my-2 space-y-2 rounded border border-line bg-surface-subtle p-2">
                                  <div>
                                    <dt className="text-ink-muted">Source role</dt>
                                    <dd className="font-medium">
                                      {fact.kind === 'declared_in'
                                        ? 'Service descriptor, not deployed source'
                                        : fact.attributes?.role === 'deployment_config'
                                          ? 'Deployment configuration'
                                          : fact.attributes?.role === 'application_source'
                                            ? 'Application source declaration'
                                            : 'Role not reported'}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt className="text-ink-muted">Recorded revision</dt>
                                    <dd className="break-all font-instrument">
                                      {fact.attributes?.revision ?? 'Not reported'}
                                    </dd>
                                  </div>
                                </dl>
                              )}
                              {fact.scope && (
                                <p className="mb-1 break-words text-ink-muted">
                                  {Object.entries(fact.scope)
                                    .map(([name, value]) => `${name}: ${value}`)
                                    .join(' · ')}
                                </p>
                              )}
                              <TopologyEvidenceSources sources={fact.sources} />
                              {facts.length > 1 && (
                                <details className="mt-2">
                                  <summary className="cursor-pointer text-info">
                                    {facts.length} resource relationships
                                  </summary>
                                  <ul
                                    className="mt-2 max-h-60 space-y-2 overflow-y-auto"
                                    aria-label="Individual evidence relationships"
                                  >
                                    {facts.map((item) => (
                                      <li key={item.key} className="break-all font-instrument">
                                        {item.from.kind} / {item.from.id} → {item.to.kind} /{' '}
                                        {item.to.id}
                                      </li>
                                    ))}
                                  </ul>
                                </details>
                              )}
                            </li>
                          )
                        );
                      })}
                    </ul>
                  </details>
                </li>
              );
            })}
          </ul>
          {relations.length > relationLimit && (
            <button
              type="button"
              onClick={() => setRelationLimit((limit) => limit + 20)}
              className="mt-3 text-sm text-info underline"
            >
              Show more relationships
            </button>
          )}
          {unresolved.length > 0 && (
            <p className="mt-3 text-sm text-warning">
              {unresolved.length} additional relationships have an unresolved endpoint. They are not
              shown as confirmed connections.
            </p>
          )}
        </div>
        <details className="border-t border-line pt-3">
          <summary className="cursor-pointer text-sm font-medium">
            Underlying resources · {entities.length}
          </summary>
          <p className="mt-2 text-xs text-ink-muted">
            Workloads are grouped only through provider ownership references. Service-to-runtime
            links require separate evidence.
          </p>
          <ul className="mt-3 space-y-3 text-sm" aria-label="Underlying topology resources">
            {entities.slice(0, resourceLimit).map((entity) => (
              <li key={entity.key} className="min-w-0 border-t border-line pt-2">
                <p className="break-words font-medium">
                  {entity.name} · {entity.attributes.resourceKind ?? entity.kind}
                  {entity.stale ? ' · Stale' : ''}
                </p>
                <details className="mt-1 text-xs text-ink-muted">
                  <summary className="cursor-pointer">Identity and evidence</summary>
                  <p className="my-2 break-all font-instrument">
                    {entity.ref.authority} / {entity.ref.kind} / {entity.ref.id}
                  </p>
                  <TopologyEvidenceSources sources={entity.sources} />
                </details>
              </li>
            ))}
          </ul>
          {entities.length > resourceLimit && (
            <button
              type="button"
              onClick={() => setResourceLimit((limit) => limit + 20)}
              className="mt-3 text-sm text-info underline"
            >
              Show more resources
            </button>
          )}
        </details>
        <details className="border-t border-line pt-3">
          <summary className="cursor-pointer text-sm font-medium">Contributing sources</summary>
          <div className="mt-3">
            <TopologyEvidenceSources sources={subject.sources} />
          </div>
        </details>
      </div>
    </section>
  );
}
