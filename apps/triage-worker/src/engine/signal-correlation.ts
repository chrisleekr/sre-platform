export interface UnresolvedSignalCandidate {
  summary: string;
  service: string;
  title: string | null;
  severity: string;
  alertName?: string | null;
  providerGroupKey?: string | null;
}

export interface GroupedResolutionObservation {
  alertName?: string;
  providerGroupKey?: string;
  externalMessageId?: string;
}

export interface GroupedEditTarget {
  externalMessageId: string;
  incidentId: string;
  alertName?: string | null;
  providerGroupKey?: string | null;
}

const ALERTMANAGER_TITLE =
  /(?:^|\n)<([^|>\n]+)\|\[\s*(?:firing|resolved)(?:\s*:\s*\d+)?\s*\]\s*([^>\n]+)>/i;

// Alertmanager's default Slack template puts the stable group labels in `attachment.fallback` and
// links the receiver after a pipe. The visible attachment title is only "[1 Alerts]" / "[RESOLVED]",
// so the older linked-title form above never sees an alert name. Strip only the changing state/count;
// the complete group label tuple and Alertmanager URL remain the provider-owned identity.
const ALERTMANAGER_FALLBACK =
  /(?:^|\n)\[\s*(?:firing|resolved)(?:\s*:\s*\d+)?\s*\]\s+([^|\n]+?)\s*\|\s*<([^|>\n]+)(?:\|[^>\n]*)?>/i;

/** Provider-owned identity carried unchanged in Alertmanager's firing and resolved title links. */
export function alertmanagerSignalIdentity(text: string): string | null {
  const linkedTitle = ALERTMANAGER_TITLE.exec(text);
  if (linkedTitle) {
    const generatorUrl = linkedTitle[1]!.trim();
    const alertName = linkedTitle[2]!.trim().replace(/\s+/g, ' ').toLowerCase();
    if (generatorUrl && alertName) return `alertmanager:${generatorUrl}|${alertName}`;
  }

  const fallback = ALERTMANAGER_FALLBACK.exec(text);
  if (!fallback) return null;
  const group = fallback[1]!.trim().replace(/\s+/g, ' ').toLowerCase();
  const alertmanagerUrl = fallback[2]!.trim();
  if (!group || !alertmanagerUrl) return null;
  return `alertmanager:${alertmanagerUrl}|${group}`;
}

/** Match only an exact, unique provider identity. Semantic similarity has no mutation authority. */
export function correlateResolution(
  text: string,
  candidates: UnresolvedSignalCandidate[],
): number | null {
  const identity = alertmanagerSignalIdentity(text);
  if (!identity) return null;
  const matches = candidates
    .map((candidate, index) => ({ index, identity: alertmanagerSignalIdentity(candidate.summary) }))
    .filter((candidate) => candidate.identity === identity);
  return matches.length === 1 ? matches[0]!.index : null;
}

/** Resolve a grouped provider notification only when every normalized alert title has one distinct
 * unresolved target. Partial or ambiguous matches have no mutation authority. */
export function correlateGroupedResolution(
  observations: GroupedResolutionObservation[],
  candidates: UnresolvedSignalCandidate[],
): number[] | null {
  if (observations.length === 0) return null;
  const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const groupKey = observations[0]?.providerGroupKey;
  if (!groupKey || observations.some((observation) => observation.providerGroupKey !== groupKey)) {
    return null;
  }
  const matches: number[] = [];
  for (const observation of observations) {
    if (!observation.alertName) return null;
    const alertName = normalize(observation.alertName);
    const candidatesForAlert = candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(
        ({ candidate }) =>
          candidate.providerGroupKey === groupKey &&
          typeof candidate.alertName === 'string' &&
          normalize(candidate.alertName) === alertName,
      );
    if (candidatesForAlert.length !== 1) return null;
    matches.push(candidatesForAlert[0]!.index);
  }
  return new Set(matches).size === matches.length ? matches : null;
}

/** Map an edit to the durable members of its exact Slack root. Exact member IDs win; otherwise a
 * unique alert title may map only within that one root and one owning incident. */
export function correlateGroupedEdit(
  observations: GroupedResolutionObservation[],
  targets: GroupedEditTarget[],
): number[] | null {
  if (observations.length === 0 || observations.length !== targets.length) return null;
  if (new Set(targets.map((target) => target.incidentId)).size !== 1) return null;
  const normalize = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const used = new Set<number>();
  const matches: number[] = [];
  for (const observation of observations) {
    let candidates = targets
      .map((target, index) => ({ target, index }))
      .filter(
        ({ target, index }) =>
          !used.has(index) && target.externalMessageId === observation.externalMessageId,
      );
    if (candidates.length === 0 && observation.alertName) {
      const alertName = normalize(observation.alertName);
      candidates = targets
        .map((target, index) => ({ target, index }))
        .filter(
          ({ target, index }) =>
            !used.has(index) &&
            typeof target.alertName === 'string' &&
            normalize(target.alertName) === alertName &&
            (!observation.providerGroupKey ||
              !target.providerGroupKey ||
              target.providerGroupKey === observation.providerGroupKey),
        );
    }
    if (candidates.length !== 1) return null;
    const index = candidates[0]!.index;
    used.add(index);
    matches.push(index);
  }
  return matches;
}
