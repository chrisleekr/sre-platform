import { publicSignalCoverage } from './signal-lifecycle-coverage';
import { resolveIncidentTopologyContext as resolveIncidentEntityContext } from '@sre/topology';
import {
  IncidentFeedbackRateLimitError,
  connectorConfigs,
  enforceIncidentFeedbackAdmissionTx,
  getIncidentDetail,
  getIncidentOwnerContext,
  presentIncidentTitles,
  getIncidentEvidenceProgress,
  getIncidentSummary,
  getInvestigationSubject,
  incidents as incidentTable,
  listIncidentRelations,
  listLatestIncidentFeedback,
  listIncidentSignals,
  listProviderRecoveryReports,
  readIncidentLlmUsage,
  readAutomaticInvestigationBudget,
  recentGitHubEvents,
  recentGitLabEvents,
  resolveGitHubRepositories,
  resolveGitLabProjects,
  upsertEntityServiceMappingTx,
  recordIncidentFeedbackTx,
  incidentSignals,
  incidentInvestigationMonitorKeys,
  incidentMessages,
  services,
  upsertServiceRepositories,
  withTenant,
} from '@sre/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { entityCapabilityGaps, scrubSecrets } from '@sre/agent-tools';
import { Hono } from 'hono';
import { type TenantAuthVariables } from '../auth';

import { UUID_RE, safeAssessment, safeSlackPermalink, type IncidentRouteDeps } from './support';
import { incidentOperatorState } from './operator-state';
import { readIncidentTagContext } from './tag-context';

function publicIncidentTitle(title: string | null): string | null {
  return title ? scrubSecrets(title) : title;
}

function publicIncidentRelations(relations: Awaited<ReturnType<typeof listIncidentRelations>>) {
  return relations.map((relation) => ({
    ...relation,
    sourceIncident: {
      ...relation.sourceIncident,
      title: publicIncidentTitle(relation.sourceIncident.title),
    },
    targetIncident: {
      ...relation.targetIncident,
      title: publicIncidentTitle(relation.targetIncident.title),
    },
  }));
}

export function registerIncidentDetailRoutes(
  app: Hono<{ Variables: TenantAuthVariables }>,
  deps: IncidentRouteDeps,
): void {
  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'incident not found' }, 404);

    const { tenantId } = c.get('tenant');
    const [incident, relations] = await Promise.all([
      getIncidentDetail(deps.db, tenantId, id),
      listIncidentRelations(deps.db, tenantId, id),
    ]);
    if (!incident) return c.json({ error: 'incident not found' }, 404);
    const [presented] = await presentIncidentTitles(deps.db, tenantId, [incident]);
    return c.json({
      ...presented,
      relations: publicIncidentRelations(relations),
    });
  });

  /** Compact incident state plus factual completed-check progress for the enriched dashboard workspace. */
  app.get('/:id/workspace', async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'incident not found' }, 404);
    const { tenantId, userId } = c.get('tenant');
    const incident = await getIncidentDetail(deps.db, tenantId, id);
    if (!incident) return c.json({ error: 'incident not found' }, 404);
    const [
      progress,
      signals,
      dataSources,
      llmUsage,
      relations,
      investigationSubject,
      entityContext,
      feedback,
      findingRows,
      ownerContext,
      tagContext,
      recoveryReports,
    ] = await Promise.all([
      getIncidentEvidenceProgress(deps.db, tenantId, id),
      listIncidentSignals(deps.db, tenantId, id),
      withTenant(deps.db, tenantId, (tx) =>
        tx
          .select({
            id: connectorConfigs.id,
            name: connectorConfigs.name,
            type: connectorConfigs.type,
          })
          .from(connectorConfigs)
          .where(
            and(
              inArray(connectorConfigs.type, ['github', 'gitlab']),
              eq(connectorConfigs.enabled, true),
              isNull(connectorConfigs.deletedAt),
            ),
          ),
      ),
      readIncidentLlmUsage(deps.db, tenantId, id),
      listIncidentRelations(deps.db, tenantId, id),
      getInvestigationSubject(deps.db, tenantId, id),
      resolveIncidentEntityContext(deps.db, tenantId, id),
      listLatestIncidentFeedback(deps.db, tenantId, id),
      withTenant(deps.db, tenantId, (tx) =>
        tx
          .selectDistinct({ runId: sql<string>`${incidentMessages.finding}->>'runId'` })
          .from(incidentMessages)
          .where(
            and(
              eq(incidentMessages.incidentId, id),
              sql`${incidentMessages.finding}->>'runId' is not null`,
              sql`${incidentMessages.finding}->>'outcome' = 'conclusive'`,
            ),
          ),
      ),
      getIncidentOwnerContext(deps.db, tenantId, id),
      readIncidentTagContext(deps.db, tenantId, id),
      listProviderRecoveryReports(deps.db, tenantId, id),
    ]);
    const entityConnectors = deps.resolveConnectors ? await deps.resolveConnectors(tenantId) : [];
    const mappedServices = entityContext?.mappings.map((mapping) => mapping.serviceName) ?? [];
    const resolvedServices = [
      ...new Set(mappedServices.length > 0 ? mappedServices : [incident.service]),
    ].sort();
    const since = new Date(incident.createdAt.getTime() - 60 * 60_000);
    const owners = ownerContext?.teams ?? [];
    const operatorState = incidentOperatorState(incident, owners, {
      signals,
      reportedSignalIds: recoveryReports.map((report) => report.signalId),
    });
    const currentBudget = deps.getAutomaticInvestigationBudget
      ? await readAutomaticInvestigationBudget(
          deps.db,
          tenantId,
          id,
          incidentInvestigationMonitorKeys(
            {
              alertSource: incident.alertSource,
              fingerprint: ownerContext!.fingerprint,
            },
            signals,
          ),
          await deps.getAutomaticInvestigationBudget(),
        )
      : null;
    const sourceEvidence = await Promise.all(
      dataSources.map(async (dataSource) => {
        const repositoryGroups = await Promise.all(
          resolvedServices.map(async (serviceName) => {
            const repositories =
              dataSource.type === 'github'
                ? await resolveGitHubRepositories(deps.db, tenantId, dataSource.id, serviceName)
                : await resolveGitLabProjects(deps.db, tenantId, dataSource.id, serviceName);
            return repositories.map((repository) => ({ ...repository, serviceName }));
          }),
        );
        const repositories = [
          ...new Map(
            repositoryGroups
              .flat()
              .map(
                (repository) =>
                  [
                    JSON.stringify([
                      repository.repositoryId,
                      repository.serviceName,
                      repository.path ?? null,
                    ]),
                    repository,
                  ] as const,
              ),
          ).values(),
        ];
        const repositoryNames = [...new Set(repositories.map((repository) => repository.fullName))];
        const events =
          dataSource.type === 'github'
            ? await recentGitHubEvents(deps.db, tenantId, dataSource.id, repositoryNames, since, 25)
            : await recentGitLabEvents(
                deps.db,
                tenantId,
                dataSource.id,
                repositoryNames,
                since,
                25,
              );
        return {
          repositories: repositories.map((repository) => ({
            ...repository,
            provider: dataSource.type as 'github' | 'gitlab',
            dataSourceId: dataSource.id,
            dataSourceName: dataSource.name,
          })),
          events: events.map((event) => ({
            ...event,
            provider: dataSource.type as 'github' | 'gitlab',
            dataSourceId: dataSource.id,
            dataSourceName: dataSource.name,
          })),
        };
      }),
    );
    const repositories = sourceEvidence.flatMap((source) => source.repositories);
    const events = sourceEvidence
      .flatMap((source) => source.events)
      .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
      .slice(0, 25);
    const publicSignals = await publicSignalCoverage(deps.db, tenantId, signals);
    const [presented] = await presentIncidentTitles(deps.db, tenantId, [incident]);
    return c.json({
      ...safeAssessment(presented!)!,
      viewerUserId: userId ?? null,
      progress,
      signals: publicSignals,
      llmUsage,
      relations: publicIncidentRelations(relations),
      investigationSubject: investigationSubject
        ? {
            kind: investigationSubject.kind,
            sourceId: investigationSubject.sourceId,
            subjectId: investigationSubject.subjectId,
            sourcePath: investigationSubject.sourcePath,
            capturedState: investigationSubject.capturedState,
            capturedSummary: investigationSubject.capturedSummary,
            capturedSnapshot: investigationSubject.capturedSnapshot,
            observedAt: investigationSubject.observedAt.toISOString(),
            currentState: investigationSubject.currentState,
            currentSummary: investigationSubject.currentSummary,
            currentSnapshot: investigationSubject.currentSnapshot,
            lastSyncedAt: investigationSubject.lastSyncedAt.toISOString(),
          }
        : null,
      entityContext: entityContext
        ? {
            ...entityContext,
            capabilityGaps: await entityCapabilityGaps(
              entityContext.observations.flatMap((observation) => observation.candidates),
              entityConnectors,
            ),
          }
        : null,
      feedback,
      feedbackEligibleFindingRunIds: findingRows.map((row) => row.runId).sort(),
      serviceTeams: owners,
      attention: operatorState.attention,
      providerRecoveryReports: recoveryReports.map((report) => ({
        signalId: report.signalId,
        reportedAt: report.reportedAt.toISOString(),
      })),
      automation: {
        nextAction: operatorState.automation,
        currentBudget,
        episodeExpiresAt: incident.correlationMaxAgeAt?.toISOString() ?? null,
      },
      codeContext: { resolvedServices, repositories, events },
      ...tagContext,
    });
  });

  /** Persists a responder-confirmed entity-to-service correction under the current tenant. */
  app.post('/:id/entity-mapping', async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'incident not found' }, 404);
    const { tenantId, userId } = c.get('tenant');
    if (!userId) return c.json({ error: 'authenticated member is required' }, 403);
    let body: { candidateKey?: unknown; serviceName?: unknown; rationale?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid entity mapping' }, 400);
    }
    const candidateKey =
      typeof body.candidateKey === 'string' && body.candidateKey.length <= 8_192
        ? body.candidateKey
        : null;
    const serviceName =
      typeof body.serviceName === 'string' && body.serviceName.trim().length <= 200
        ? body.serviceName.trim()
        : null;
    const rationaleInput =
      typeof body.rationale === 'string' && body.rationale.trim().length <= 1_000
        ? body.rationale.trim()
        : null;
    if (!candidateKey || !serviceName || !rationaleInput)
      return c.json({ error: 'candidate, catalog service, and reason are required' }, 400);
    const rationale = scrubSecrets(rationaleInput);
    const updateMapping = () =>
      withTenant(deps.db, tenantId, async (tx) => {
        await enforceIncidentFeedbackAdmissionTx(tx, tenantId, userId);
        const current = await tx
          .select({ id: incidentTable.id, archivedAt: incidentTable.archivedAt })
          .from(incidentTable)
          .where(eq(incidentTable.id, id))
          .limit(1)
          .for('update');
        if (!current[0] || current[0].archivedAt) return 'not_found' as const;
        const [catalog] = await tx
          .select({ name: services.name })
          .from(services)
          .where(eq(services.name, serviceName))
          .limit(1);
        if (!catalog) return 'service_not_found' as const;
        const signalRows = await tx
          .select({ candidates: incidentSignals.affectedEntities })
          .from(incidentSignals)
          .where(eq(incidentSignals.incidentId, id));
        const candidate = signalRows
          .flatMap((signal) => signal.candidates ?? [])
          .find((item) => item.key === candidateKey);
        if (!candidate) return 'candidate_not_found' as const;
        await upsertEntityServiceMappingTx(tx, tenantId, {
          candidateKey,
          candidateKind: candidate.kind,
          serviceName,
          confirmedByUserId: userId,
          rationale,
        });
        await recordIncidentFeedbackTx(tx, tenantId, id, {
          targetType: 'entity',
          targetId: candidateKey,
          decision:
            candidate.kind === 'service' && candidate.stableId === serviceName
              ? 'confirm'
              : 'correct',
          rationale,
          correction: { serviceName },
          createdByUserId: userId,
        });
        return 'ok' as const;
      });
    let outcome: Awaited<ReturnType<typeof updateMapping>>;
    try {
      outcome = await updateMapping();
    } catch (error) {
      if (error instanceof IncidentFeedbackRateLimitError)
        return c.json({ error: error.message }, 429);
      throw error;
    }
    if (outcome === 'not_found') return c.json({ error: 'incident not found' }, 404);
    if (outcome === 'service_not_found') return c.json({ error: 'catalog service not found' }, 404);
    if (outcome === 'candidate_not_found')
      return c.json({ error: 'entity candidate not found' }, 404);
    return c.json({ ok: true });
  });

  /** Best-effort Slack-owned deep link, loaded separately so Slack latency never blocks the workspace. */
  app.get('/:id/slack-permalink', async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'incident not found' }, 404);
    const { tenantId } = c.get('tenant');
    const incident = await getIncidentDetail(deps.db, tenantId, id);
    if (!incident) return c.json({ error: 'incident not found' }, 404);
    if (
      incident.originSurface !== 'slack' ||
      !incident.originChannel ||
      !incident.originThreadId ||
      !deps.resolveSlackPermalink
    ) {
      return c.json({ permalink: null });
    }
    const permalink = await deps.resolveSlackPermalink(
      tenantId,
      incident.originChannel,
      incident.originThreadId,
    );
    return c.json({ permalink: safeSlackPermalink(permalink) });
  });

  /** Confirm the currently resolved repository relationship before remediation uses it as fact. */
  app.post('/:id/code-context/confirm', async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'incident not found' }, 404);
    const { tenantId } = c.get('tenant');
    const incident = await getIncidentSummary(deps.db, tenantId, id);
    if (!incident) return c.json({ error: 'incident not found' }, 404);
    let body: {
      repositoryId?: unknown;
      provider?: unknown;
      dataSourceId?: unknown;
      serviceName?: unknown;
      path?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid repository confirmation' }, 400);
    }
    const repositoryId =
      typeof body.repositoryId === 'string' && /^\d+$/.test(body.repositoryId)
        ? body.repositoryId
        : null;
    if (!repositoryId) return c.json({ error: 'invalid repository confirmation' }, 400);
    const provider =
      body.provider === undefined
        ? 'github'
        : body.provider === 'github' || body.provider === 'gitlab'
          ? body.provider
          : null;
    if (!provider) return c.json({ error: 'invalid repository confirmation' }, 400);
    const dataSourceId =
      typeof body.dataSourceId === 'string' && UUID_RE.test(body.dataSourceId)
        ? body.dataSourceId
        : null;
    if (!dataSourceId) return c.json({ error: 'data source ID is required' }, 400);
    const serviceName =
      typeof body.serviceName === 'string' && body.serviceName.trim().length <= 200
        ? body.serviceName.trim()
        : null;
    if (!serviceName) return c.json({ error: 'catalog service is required' }, 400);
    const requestedPath =
      body.path === undefined
        ? undefined
        : body.path === null
          ? ''
          : typeof body.path === 'string' && body.path.trim().length <= 2_048
            ? body.path.trim()
            : false;
    if (requestedPath === false) return c.json({ error: 'invalid repository confirmation' }, 400);
    const entityContext = await resolveIncidentEntityContext(deps.db, tenantId, id);
    const mappedServices = entityContext?.mappings.map((mapping) => mapping.serviceName) ?? [];
    const allowedServices = new Set(
      mappedServices.length > 0 ? mappedServices : [incident.service],
    );
    if (!allowedServices.has(serviceName))
      return c.json({ error: 'catalog service is not resolved for this incident' }, 409);
    const repositories =
      provider === 'github'
        ? await resolveGitHubRepositories(deps.db, tenantId, dataSourceId, serviceName)
        : await resolveGitLabProjects(deps.db, tenantId, dataSourceId, serviceName);
    const matchingRepositories = repositories.filter(
      (candidate) => candidate.repositoryId === repositoryId,
    );
    const repository =
      requestedPath === undefined
        ? matchingRepositories.length === 1
          ? matchingRepositories[0]
          : null
        : matchingRepositories.find((candidate) => (candidate.path ?? '').trim() === requestedPath);
    if (requestedPath === undefined && matchingRepositories.length > 1)
      return c.json({ error: 'repository path is required' }, 409);
    if (!repository) return c.json({ error: 'repository relationship not found' }, 404);
    const confirmed = await withTenant(deps.db, tenantId, async (tx) => {
      const current = await tx
        .select({ archivedAt: incidentTable.archivedAt })
        .from(incidentTable)
        .where(eq(incidentTable.id, id))
        .limit(1)
        .for('update');
      if (!current[0] || current[0].archivedAt) return false;
      await upsertServiceRepositories(tx, tenantId, [
        {
          service: serviceName,
          provider,
          repositoryFullName: repository.fullName,
          ...(repository.path ? { path: repository.path } : {}),
          source: 'dashboard',
          confirmed: true,
        },
      ]);
      return true;
    });
    if (!confirmed) return c.json({ error: 'incident not found' }, 404);
    return c.json({ ok: true });
  });

  /** Explicit human lifecycle transition. The hub commits the state and audit line atomically. */
}
