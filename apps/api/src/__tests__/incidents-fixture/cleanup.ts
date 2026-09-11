import {
  agentToolCalls,
  approvals,
  assessmentGrades,
  connectorConfigs,
  deployments,
  entityServiceMappings,
  githubEvents,
  githubRepositories,
  inboundChannels,
  incidentFeedback,
  incidentMessages,
  incidentRelations,
  incidentSignals,
  incidentTagSuggestions,
  incidentTags,
  incidents,
  investigationRuns,
  investigationSubjects,
  jobs,
  knowledgeChunks,
  memberships,
  platformOperators,
  postmortems,
  serviceRepositories,
  serviceDependencies,
  services,
  signalDispositionEvaluations,
  signalDispositions,
  surfaceBindings,
  surfaceConfigs,
  surfaceDeliveries,
  tenantIdentityBindings,
  tenants,
  tenantSignalPolicies,
  tenantTagLinkRules,
  users,
  type DbHandle,
} from '@sre/db';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll } from 'vitest';

interface CleanupState {
  admin: DbHandle;
  app: DbHandle;
  redis: Redis;
  tenantA: string;
  tenantB: string;
  tenantC: string;
  tenantCUserId: string;
  issuer: string;
  orgA: string;
  orgB: string;
  orgC: string;
}

export function registerIncidentFixtureCleanup(read: () => CleanupState): void {
  afterAll(async () => {
    const {
      admin,
      app,
      redis,
      tenantA,
      tenantB,
      tenantC,
      tenantCUserId,
      issuer,
      orgA,
      orgB,
      orgC,
    } = read();
    const tenantScope = sql`tenant_id in (${tenantA}, ${tenantB}, ${tenantC})`;
    if (admin) {
      await admin.db
        .update(incidents)
        .set({ recoveryRunId: null, trustedAssessmentRunId: null })
        .where(tenantScope);
      for (const table of [
        jobs,
        assessmentGrades,
        postmortems,
        tenantSignalPolicies,
        signalDispositionEvaluations,
        signalDispositions,
        surfaceDeliveries,
        agentToolCalls,
        githubEvents,
        entityServiceMappings,
        serviceRepositories,
        serviceDependencies,
        deployments,
        knowledgeChunks,
        services,
        githubRepositories,
        connectorConfigs,
        investigationSubjects,
        incidentFeedback,
        incidentTagSuggestions,
        incidentTags,
        tenantTagLinkRules,
        incidentMessages,
        incidentSignals,
        incidentRelations,
        approvals,
        surfaceBindings,
        inboundChannels,
        surfaceConfigs,
        investigationRuns,
        incidents,
        memberships,
        tenantIdentityBindings,
      ]) {
        await admin.db.delete(table).where(tenantScope);
      }
      await admin.db.delete(platformOperators).where(eq(platformOperators.userId, tenantCUserId));
      await admin.db
        .delete(users)
        .where(sql`issuer = ${issuer} and subject in (${orgA}, ${orgB}, ${orgC})`);
      await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB}, ${tenantC})`);
      await admin.close();
    }
    if (app) await app.close();
    if (redis) await redis.quit();
  });
}
