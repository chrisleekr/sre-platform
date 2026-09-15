import {
  MAX_PROVIDER_CALLS,
  MAX_REPOSITORIES,
  MAX_RUNTIME_ARTIFACTS,
  investigateCodeInput,
  type CodeLocationEvidence,
  type InvestigateCodeDeps,
  type InvestigateCodeInput,
  type InvestigateCodeResult,
  type RepositoryTarget,
  type ResolvedRevision,
} from './code-intelligence/contracts';
import {
  ProviderCallBudgetExceeded,
  codeContextReader,
  codeLocation,
  isBudgetFailure,
  normalizedText,
  observeArtifacts,
  pathCandidates,
  queryAnchors,
  repositoryRank,
  resolveRepositories,
  resolveRevision,
  stackAnchors,
} from './code-intelligence/helpers';
import type { ToolContext, ToolDefinition } from './types';
import {
  resolveTopologyRepositories,
  topologyRepositoryIdentity,
} from './code-intelligence/topology';

export * from './code-intelligence/contracts';

/**
 * Builds the provider-neutral code investigation tool.
 *
 * @param deps - Trusted repository, connector, incident, and evidence dependencies.
 */
export function makeInvestigateCodeTool(
  deps: InvestigateCodeDeps,
): ToolDefinition<InvestigateCodeInput, InvestigateCodeResult> {
  const context = codeContextReader(deps);
  return {
    name: 'investigate_code',
    description:
      'Use the incident’s exact topology source associations when available, otherwise its legacy catalog context, to locate stack paths, symbols, or error text in authorized repositories. Ambiguous topology never falls back to a similar repository name. Declared revisions are not verified runtime provenance; legacy default-branch matches remain candidate evidence.',
    inputSchema: investigateCodeInput,
    async handler(ctx: ToolContext, input) {
      const incident = await context.incident(ctx.tenantId, ctx.incidentId);
      if (!incident) throw new Error('code investigation incident unavailable');
      const incidentAt =
        (await context.onset?.(ctx.tenantId, ctx.incidentId)) ?? incident.createdAt;
      const sourceEvidenceIds = input.evidenceIds?.length
        ? ((await context.evidenceIds?.(ctx.tenantId, ctx.incidentId, input.evidenceIds)) ?? [])
        : [];
      const connectors = await ctx.resolveConnectors();
      const topologySources = await context.sources?.(ctx.tenantId, ctx.incidentId, ctx.service);
      const [
        {
          artifacts,
          failed: artifactReadFailed,
          countTruncated: artifactsCountTruncated,
          readerIncomplete: artifactReadersIncomplete,
        },
        { repositories, failed: repositoryReadFailed },
      ] = await Promise.all([
        topologySources
          ? Promise.resolve({
              artifacts: [],
              failed: false,
              countTruncated: false,
              readerIncomplete: false,
            })
          : observeArtifacts(connectors, ctx.service),
        topologySources
          ? resolveTopologyRepositories(connectors, topologySources)
          : resolveRepositories(connectors, ctx.service),
      ]);
      const anchors = stackAnchors(normalizedText(input.stackTrace));
      const searches = queryAnchors(input, anchors);
      const baseUncertainties = [
        ...(topologySources ? [topologySources.note] : []),
        ...(artifactReadFailed ? ['one or more runtime artifact readers were unavailable'] : []),
        ...(artifactsCountTruncated
          ? [`runtime artifacts were capped at ${MAX_RUNTIME_ARTIFACTS}`]
          : []),
        ...(artifactReadersIncomplete
          ? ['one or more runtime artifact readers returned incomplete coverage']
          : []),
        ...(repositoryReadFailed
          ? ['one or more repository catalog readers were unavailable']
          : []),
      ];
      if (anchors.length === 0 && searches.length === 0) {
        return {
          available: true,
          data: {
            status: 'no_code_anchor',
            artifacts,
            revisions: [],
            evidence: [],
            uncertainties: baseUncertainties,
            requiredSetup: ['provide a stack path, symbol, error token, or code-focused question'],
          },
        };
      }
      const ranked = repositories.sort(
        (a, b) => repositoryRank(a, artifacts) - repositoryRank(b, artifacts),
      );
      const candidates = ranked;
      const cutoffAmbiguous =
        candidates.length > MAX_REPOSITORIES &&
        repositoryRank(candidates[MAX_REPOSITORIES - 1]!, artifacts) ===
          repositoryRank(candidates[MAX_REPOSITORIES]!, artifacts);
      const targets = cutoffAmbiguous ? [] : candidates.slice(0, MAX_REPOSITORIES);
      if (candidates.length === 0 || cutoffAmbiguous) {
        return {
          available: true,
          data: {
            status:
              topologySources?.status === 'ambiguous'
                ? 'ambiguous'
                : candidates.length === 0
                  ? 'missing_mapping'
                  : 'ambiguous',
            artifacts,
            revisions: [],
            evidence: [],
            uncertainties: [
              ...baseUncertainties,
              candidates.length === 0
                ? 'no service-to-repository relationship resolved'
                : `repository candidates tie at the automatic limit of ${MAX_REPOSITORIES}`,
            ],
            requiredSetup: [
              topologySources
                ? 'inspect the incident topology matches and source evidence; verify connection scope and resource source declarations'
                : 'confirm the service repository mapping and monorepo path in the service catalog',
            ],
          },
        };
      }

      let providerCalls = 0;
      const consume = () => {
        if (providerCalls >= MAX_PROVIDER_CALLS)
          throw new ProviderCallBudgetExceeded('code investigation provider-call budget exhausted');
        providerCalls += 1;
      };
      const remaining = () => MAX_PROVIDER_CALLS - providerCalls;
      let budgetExhausted = false;
      const revisions: Array<{ target: RepositoryTarget; resolved: ResolvedRevision }> = [];
      const uncertainties = [...baseUncertainties];
      for (const target of targets) {
        try {
          const boundary = target.topology
            ? { current: null, previous: null, firstAfter: null }
            : await context.deploymentBoundary(
                ctx.tenantId,
                ctx.service,
                target.repository,
                incidentAt,
              );
          const resolved = await resolveRevision(target, artifacts, boundary, consume);
          if (resolved) revisions.push({ target, resolved });
        } catch (error) {
          if (isBudgetFailure(error)) {
            budgetExhausted = true;
            break;
          }
          uncertainties.push(`revision unavailable for ${target.repository.fullName}`);
        }
      }
      if (budgetExhausted) uncertainties.push('code investigation provider-call budget exhausted');
      if (revisions.length === 0) {
        return {
          available: true,
          data: {
            status: 'missing_revision',
            artifacts,
            revisions: [],
            evidence: [],
            uncertainties,
            requiredSetup: [
              'publish source repository and commit metadata with the runtime artifact or deployment event',
            ],
          },
        };
      }

      const evidence: CodeLocationEvidence[] = [];
      repositoryLoop: for (const { target, resolved } of revisions) {
        let found = false;
        for (const anchor of anchors) {
          for (const path of pathCandidates(anchor.path, target.repository.pathPrefix)) {
            try {
              evidence.push(
                await codeLocation(
                  target,
                  resolved,
                  path,
                  anchor.line,
                  input,
                  anchor,
                  null,
                  sourceEvidenceIds,
                  consume,
                  remaining,
                ),
              );
              found = true;
              break;
            } catch (error) {
              if (isBudgetFailure(error)) {
                budgetExhausted = true;
                break repositoryLoop;
              }
              // A runtime root or source-map mismatch may require the next bounded suffix candidate.
            }
          }
          if (found) break;
        }
        if (found) continue;

        for (const search of searches) {
          try {
            consume();
            const discovery = await target.reader.search(target.repository, search.query, 10);
            if (discovery.incomplete || discovery.matches.length > 3)
              uncertainties.push(`code search was incomplete for ${target.repository.fullName}`);
            for (const match of discovery.matches.slice(0, 3)) {
              try {
                evidence.push(
                  await codeLocation(
                    target,
                    resolved,
                    match.path,
                    match.line,
                    input,
                    null,
                    search,
                    sourceEvidenceIds,
                    consume,
                    remaining,
                  ),
                );
                found = true;
                break;
              } catch (error) {
                if (isBudgetFailure(error)) {
                  budgetExhausted = true;
                  break repositoryLoop;
                }
                // Provider search is default-branch discovery. The path may not exist at the deployed ref.
              }
            }
          } catch (error) {
            if (isBudgetFailure(error)) {
              budgetExhausted = true;
              break repositoryLoop;
            }
            uncertainties.push(`code search unavailable for ${target.repository.fullName}`);
          }
          if (found) break;
        }
      }

      if (
        budgetExhausted &&
        !uncertainties.includes('code investigation provider-call budget exhausted')
      )
        uncertainties.push('code investigation provider-call budget exhausted');

      const revisionEvidence = revisions.map(({ resolved }) => resolved.evidence);
      if (topologySources) {
        let current = false;
        try {
          const sources = await context.sources?.(ctx.tenantId, ctx.incidentId, ctx.service);
          if (sources) {
            const admitted = await resolveTopologyRepositories(
              await ctx.resolveConnectors(),
              sources,
            );
            const identities = new Set(admitted.repositories.map(topologyRepositoryIdentity));
            current = revisions.every(({ target }) =>
              identities.has(topologyRepositoryIdentity(target)),
            );
          }
        } catch {
          // A failed authorization recheck cannot release the captured source content.
        }
        if (!current)
          return {
            available: true,
            data: {
              status: 'source_changed',
              artifacts: [],
              revisions: [],
              evidence: [],
              uncertainties: [
                'Source access or topology associations changed or could not be revalidated during the read.',
              ],
              requiredSetup: [
                'Refresh topology source evidence before reading this configuration again.',
              ],
            },
          };
      }
      for (const revision of revisionEvidence) uncertainties.push(...revision.uncertainties);
      return {
        available: true,
        data: {
          status: evidence.length > 0 ? 'located' : 'no_match',
          artifacts,
          revisions: revisionEvidence,
          evidence: evidence.slice(0, 6),
          uncertainties: [...new Set(uncertainties)],
          requiredSetup: revisionEvidence.some((revision) => revision.basis === 'default_head')
            ? [
                'bind the running artifact or deployment to an exact application repository revision',
              ]
            : [],
        },
      };
    },
  };
}
