import type { AffectedEntityCandidate, EntityCapabilityGap } from '@sre/contracts';
import type { Db } from '@sre/db';
import { resolveIncidentTopologyContext } from '@sre/topology';
import type { IDataSourceConnector } from '@sre/connectors';
import * as z from 'zod';
import type { ToolContext, ToolDefinition } from './types';
import { topologyReferences } from './topology-references';

function modelEntityContext(
  context: NonNullable<Awaited<ReturnType<typeof resolveIncidentTopologyContext>>>,
  capabilityGaps: EntityCapabilityGap[],
) {
  const references = new Map<string, string>();
  const entityRef = (key: string): string => {
    const existing = references.get(key);
    if (existing) return existing;
    const reference = `entity-${references.size + 1}`;
    references.set(key, reference);
    return reference;
  };
  return {
    observations: context.observations.map((observation) => ({
      ...observation,
      candidates: observation.candidates.map((candidate) => {
        const { key, ...details } = candidate;
        return { entityRef: entityRef(key), ...details };
      }),
    })),
    mappings: context.mappings.map((mapping) => {
      const { candidateKey, ...details } = mapping;
      return { entityRef: entityRef(candidateKey), ...details };
    }),
    services: context.services,
    topology: {
      ...context.topology,
      resolutions: context.topology.resolutions.map(({ candidateKey, ...resolution }) => ({
        entityRef: entityRef(candidateKey),
        ...resolution,
      })),
    },
    capabilityGaps: capabilityGaps.map((gap) => {
      const { entityKey, ...details } = gap;
      return { entityRef: entityRef(entityKey), ...details };
    }),
  };
}

/**
 * Explains which configured connector capability is missing for each affected entity.
 *
 * @param candidates - Typed entities extracted from incident signals.
 * @param connectors - Enabled tenant connector instances.
 */
export async function entityCapabilityGaps(
  candidates: AffectedEntityCandidate[],
  connectors: IDataSourceConnector[],
): Promise<EntityCapabilityGap[]> {
  const gaps: EntityCapabilityGap[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    for (const capability of candidate.requiredCapabilities) {
      const identity = `${candidate.key}:${capability}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const providers = connectors.filter((connector) =>
        connector.entityCoverage?.capabilities.includes(capability),
      );
      const assessments = await Promise.all(
        providers.map(async (connector) => ({
          connector,
          status: await connector.entityCoverage!.assess(candidate),
        })),
      );
      if (assessments.some(({ status }) => status === 'covered')) continue;
      const unavailable = assessments.some(({ status }) => status === 'unavailable');
      const scopeMismatch = assessments.some(({ status }) => status === 'out_of_scope');
      const relevant = assessments.filter(
        ({ status }) => status === 'unavailable' || status === 'out_of_scope',
      );
      const firstMismatch = relevant.find(({ status }) => status === 'out_of_scope');
      const requiredScope = {
        kind: candidate.kind,
        entity: candidate.stableId,
        ...candidate.scope,
      };
      const scopeText = (scope: Readonly<Record<string, string>>): string =>
        Object.entries(scope)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ') || 'no explicit boundary';
      gaps.push({
        entityKey: candidate.key,
        capability,
        reason: unavailable
          ? 'connector_unavailable'
          : scopeMismatch
            ? 'scope_mismatch'
            : 'connector_missing',
        summary: unavailable
          ? `${relevant.find(({ status }) => status === 'unavailable')?.connector.name ?? 'Configured data source'} cannot currently provide ${capability.replaceAll('_', ' ')} evidence for this ${candidate.kind}.`
          : scopeMismatch && firstMismatch
            ? `${firstMismatch.connector.name} is scoped to ${scopeText(firstMismatch.connector.entityCoverage?.scope ?? {})}; this ${candidate.kind} requires ${scopeText(requiredScope)}.`
            : `No configured connector can provide ${capability.replaceAll('_', ' ')} evidence for this ${candidate.kind}.`,
        requiredScope,
        connectors: relevant.map(({ connector, status }) => ({
          id: connector.id,
          name: connector.name,
          type: connector.type,
          status: status as 'out_of_scope' | 'unavailable',
          currentScope: connector.entityCoverage?.scope ?? {},
        })),
        action: {
          label: unavailable
            ? 'Repair data source access'
            : scopeMismatch
              ? 'Adjust data source scope'
              : 'Configure data source',
          href: '/connectors',
        },
      });
    }
  }
  return gaps;
}

/**
 * Builds the provider-neutral incident entity-resolution tool.
 *
 * @param deps - Tenant-scoped entity context persistence.
 */
export function makeResolveEntityContextTool(deps: {
  db: Db;
}): ToolDefinition<Record<string, never>, unknown> {
  return {
    name: 'resolve_entity_context',
    description:
      'Resolve signal sources and affected entity candidates to catalog ownership, dependencies, repositories, deployments, and runbooks. Returns typed configuration gaps when no connector covers a required read.',
    inputSchema: z.object({}).strict(),
    async handler(ctx: ToolContext) {
      const context = await resolveIncidentTopologyContext(deps.db, ctx.tenantId, ctx.incidentId);
      if (!context) throw new Error('incident entity context unavailable');
      const connectors = await ctx.resolveConnectors();
      const candidates = context.observations.flatMap((observation) => observation.candidates);
      const capabilityGaps = await entityCapabilityGaps(candidates, connectors);
      return {
        available: true,
        data: topologyReferences(modelEntityContext(context, capabilityGaps)),
      };
    },
  };
}
