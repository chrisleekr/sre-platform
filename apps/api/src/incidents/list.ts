import { scrubSecrets } from '@sre/agent-tools';
import { openIncidentWorkspace } from '@sre/alerts';
import {
  countIncidentsByScope,
  listIncidents,
  listIncidentsPage,
  presentIncidentTitles,
  readIncidentFreeStatus,
  type IncidentFreeStatusSnapshot,
  type IncidentListItem,
  type IncidentPageCursor,
} from '@sre/db';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { type TenantAuthVariables } from '../auth';
import {
  ObservationNotActionableError,
  ObservationNotFoundError,
  ObservationUnavailableError,
  activeObservationWorkspaces,
  declareObservation,
  type ObservationSubject,
} from '../incident-observations';
import { safeErrorMetadata } from '../logger';

import {
  MAX_MANUAL_DECLARATION_BODY_BYTES,
  ManualIncidentRateLimitError,
  UUID_RE,
  decodeCursor,
  encodeCursor,
  enforceManualIncidentAdmission,
  isStatus,
  parseLimit,
  parseManualIncidentRequest,
  parseObservationSubject,
  type IncidentRouteDeps,
} from './support';
import { incidentOperatorState } from './operator-state';

function incidentQueueState(incident: IncidentListItem) {
  const operator = incidentOperatorState(
    incident,
    incident.responsibleOwner ? [incident.responsibleOwner] : [],
  );
  return {
    ...incident,
    title: incident.title ? scrubSecrets(incident.title) : incident.title,
    attentionDecision: operator.attention?.decision ?? null,
    nextAutomation: operator.automation,
  };
}

type IncidentFreeStatusResponse =
  | IncidentFreeStatusSnapshot
  | {
      state: 'unavailable';
      asOf: Date;
      startedAt: null;
      qualifyingActiveCount: 0;
      scope: { severities: ['sev1', 'sev2'] };
      lastIncident: null;
    };

function unavailableIncidentFreeStatus(): IncidentFreeStatusResponse {
  return {
    state: 'unavailable',
    asOf: new Date(),
    startedAt: null,
    qualifyingActiveCount: 0,
    scope: { severities: ['sev1', 'sev2'] },
    lastIncident: null,
  };
}

function publicIncidentFreeStatus(status: IncidentFreeStatusResponse): IncidentFreeStatusResponse {
  if (status.state !== 'running' || !status.lastIncident) return status;
  return {
    ...status,
    lastIncident: {
      ...status.lastIncident,
      title: status.lastIncident.title ? scrubSecrets(status.lastIncident.title) : null,
    },
  };
}

export function registerIncidentListRoutes(
  app: Hono<{ Variables: TenantAuthVariables }>,
  deps: IncidentRouteDeps,
): void {
  app.get('/', async (c) => {
    const { tenantId } = c.get('tenant');
    const state = c.req.query('state');
    if (state === 'open' || state === 'closed' || state === 'all') {
      const query = c.req.query('query')?.trim();
      if (query && query.length > 200) return c.json({ error: 'query is too long' }, 400);
      if (query && query.length < 3 && !UUID_RE.test(query)) {
        return c.json({ error: 'query must contain at least 3 characters' }, 400);
      }
      const severity = c.req.query('severity');
      if (severity !== undefined && !['sev1', 'sev2', 'sev3'].includes(severity)) {
        return c.json({ error: 'severity must be sev1, sev2, or sev3' }, 400);
      }
      const attention = c.req.query('attention');
      if (
        attention !== undefined &&
        (state !== 'open' || (attention !== 'human' && attention !== 'automation'))
      ) {
        return c.json(
          { error: 'attention is only valid as human or automation for open incidents' },
          400,
        );
      }
      let before: IncidentPageCursor | undefined;
      const cursor = c.req.query('cursor');
      if (cursor !== undefined) {
        if (state === 'open')
          return c.json({ error: 'cursor is only valid for closed or all incidents' }, 400);
        const decoded = decodeCursor(cursor);
        if (!decoded) return c.json({ error: 'invalid cursor' }, 400);
        before = decoded;
      }
      const incidentFreeStatusPromise =
        state === 'open'
          ? readIncidentFreeStatus(deps.db, tenantId).catch((error: unknown) => {
              deps.log?.error('Incident-free status projection failed', {
                tenantId,
                ...safeErrorMetadata(error),
              });
              return unavailableIncidentFreeStatus();
            })
          : Promise.resolve(null);
      const [page, counts, incidentFreeStatus, operationalCounts] = await Promise.all([
        listIncidentsPage(deps.db, tenantId, {
          scope: state,
          attention,
          query: query || undefined,
          severity,
          limit: parseLimit(c.req.query('limit')),
          before,
        }),
        countIncidentsByScope(deps.db, tenantId),
        incidentFreeStatusPromise,
        countIncidentsByScope(deps.db, tenantId, 'incident'),
      ]);
      return c.json({
        incidents: await presentIncidentTitles(
          deps.db,
          tenantId,
          page.incidents.map(incidentQueueState),
        ),
        nextCursor: state !== 'open' && page.nextCursor ? encodeCursor(page.nextCursor) : null,
        counts,
        operationalCounts,
        ...(incidentFreeStatus
          ? { incidentFreeStatus: publicIncidentFreeStatus(incidentFreeStatus) }
          : {}),
      });
    }
    const status = c.req.query('status');
    if (status !== undefined && !isStatus(status)) {
      return c.json({ error: 'invalid incident status' }, 400);
    }
    const incidents = await listIncidents(deps.db, tenantId, {
      status,
    });
    return c.json({
      incidents: await presentIncidentTitles(deps.db, tenantId, incidents.map(incidentQueueState)),
    });
  });

  app.post(
    '/',
    bodyLimit({
      maxSize: MAX_MANUAL_DECLARATION_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
    async (c) => {
      const { tenantId, userId } = c.get('tenant');
      if (!deps.declarationQueue || !deps.hub)
        return c.json({ error: 'incident declaration unavailable' }, 503);
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: 'invalid request' }, 400);
      }
      const request = parseManualIncidentRequest(raw);
      if (!request) return c.json({ error: 'invalid request' }, 400);

      const title = scrubSecrets(request.title);
      const description = scrubSecrets(request.description);
      const service = scrubSecrets(request.service);
      const observedAt = new Date();
      try {
        const opened = await openIncidentWorkspace(
          {
            appDb: deps.db,
            queue: deps.declarationQueue,
            appendOpenerTx: async (tx, scopedTenantId, incidentId, opener) => {
              await enforceManualIncidentAdmission(tx, scopedTenantId, userId ?? null);
              const human = await deps.hub!.appendTxOnce(tx, scopedTenantId, incidentId, opener);
              const lifecycle = await deps.hub!.appendTxOnce(tx, scopedTenantId, incidentId, {
                author: 'system',
                kind: 'lifecycle',
                content: 'Incident created from the dashboard.',
                lifecycleFrom: null,
                lifecycleTo: 'open',
                lifecycleVersion: 0,
                transitionKey: `manual-open:${incidentId}:0`,
              });
              return {
                incidentId,
                afterCommit: async () => {
                  await deps.hub!.publishAppended(human.message);
                  await deps.hub!.publishAppended(lifecycle.message);
                },
              };
            },
          },
          {
            tenantId,
            fingerprint: `manual:${request.requestId}`,
            source: 'manual',
            service,
            severity: request.severity,
            title,
            context: {
              kind: 'human_report',
              description,
              reportedAt: observedAt.toISOString(),
            },
            investigationTrigger: {
              reason: 'manual_investigation',
              automatic: false,
              monitorKey: null,
            },
            opener: {
              author: 'human',
              content: description,
              originSurface: 'dashboard',
              originMessageId: `dashboard:manual:${request.requestId}`,
              authorUserId: userId ?? null,
            },
          },
        );
        deps.log?.info('manual incident declaration', {
          tenantId,
          actorUserId: userId ?? null,
          outcome: opened.outcome,
          incidentId: opened.incidentId,
          triageJobCreated: opened.jobId !== null,
        });
        return c.json(
          { outcome: opened.outcome, incidentId: opened.incidentId },
          opened.outcome === 'created' ? 201 : 200,
        );
      } catch (error) {
        if (error instanceof ManualIncidentRateLimitError) {
          deps.log?.info('manual incident declaration rate limited', {
            tenantId,
            actorUserId: userId ?? null,
            triageJobCreated: false,
          });
          c.header('Retry-After', '60');
          return c.json({ error: 'manual incident creation rate limited' }, 429);
        }
        deps.log?.error('manual incident declaration failed', {
          tenantId,
          actorUserId: userId ?? null,
          triageJobCreated: false,
          ...safeErrorMetadata(error),
        });
        return c.json({ error: 'incident declaration failed' }, 500);
      }
    },
  );

  app.post('/from-observation', async (c) => {
    const { tenantId, userId } = c.get('tenant');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid request' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return c.json({ error: 'invalid request' }, 400);
    const record = body as Record<string, unknown>;
    if (Object.keys(record).length !== 1 || !('subject' in record))
      return c.json({ error: 'invalid request' }, 400);
    const subject = parseObservationSubject(record.subject);
    if (!subject) return c.json({ error: 'invalid request' }, 400);
    if (!deps.declarationQueue) return c.json({ error: 'incident declaration unavailable' }, 503);
    try {
      const opened = await declareObservation(
        { db: deps.db, cache: deps.cache, queue: deps.declarationQueue },
        tenantId,
        subject,
      );
      deps.log?.info('incident observation declaration', {
        tenantId,
        actorUserId: userId ?? null,
        kind: subject.kind,
        outcome: opened.outcome,
        incidentId: opened.incidentId,
        triageJobCreated: opened.jobId !== null,
      });
      return c.json(
        { outcome: opened.outcome, incidentId: opened.incidentId },
        opened.outcome === 'created' ? 201 : 200,
      );
    } catch (error) {
      const outcome =
        error instanceof ObservationNotFoundError
          ? 'not_found'
          : error instanceof ObservationNotActionableError
            ? 'not_actionable'
            : error instanceof ObservationUnavailableError
              ? 'unavailable'
              : 'failed';
      deps.log?.info('incident observation declaration', {
        tenantId,
        actorUserId: userId ?? null,
        kind: subject.kind,
        outcome,
        triageJobCreated: false,
      });
      if (error instanceof ObservationNotFoundError)
        return c.json({ error: 'observation not found' }, 404);
      if (error instanceof ObservationNotActionableError)
        return c.json({ error: 'observation is no longer actionable' }, 409);
      if (error instanceof ObservationUnavailableError)
        return c.json({ error: 'observation source unavailable' }, 503);
      return c.json({ error: 'incident declaration failed' }, 500);
    }
  });

  app.post('/observation-workspaces', async (c) => {
    const { tenantId } = c.get('tenant');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid request' }, 400);
    }
    const subjects =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as { subjects?: unknown }).subjects
        : null;
    if (!Array.isArray(subjects) || subjects.length > 500)
      return c.json({ error: 'invalid request' }, 400);
    const parsed = subjects.map(parseObservationSubject);
    if (parsed.some((subject) => !subject)) return c.json({ error: 'invalid request' }, 400);
    const active = await activeObservationWorkspaces(
      deps.db,
      tenantId,
      parsed as ObservationSubject[],
    );
    return c.json({ active });
  });
}
