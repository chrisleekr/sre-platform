import { scrubSecrets } from '@sre/agent-tools';
import {
  POSTMORTEM_TIMELINE_AT_MAX_CHARS,
  POSTMORTEM_TRIGGERS,
  type ContributingCause,
  type PostmortemLessons,
  type PostmortemSections,
  type PostmortemTimelineEntry,
  type PostmortemTrigger,
} from '@sre/contracts';
import {
  getIncidentSummary,
  getPostmortemDetail,
  getPostmortemStatus,
  publishPostmortem,
  updatePostmortemSections,
} from '@sre/db';
import { IncidentMovedError, IncidentUnavailableError } from '@sre/queue';
import { Hono } from 'hono';
import { type TenantAuthVariables } from '../auth';
import { UUID_RE, type IncidentRouteDeps } from './support';

const MAX_SECTION_CHARS = 20_000;
const MAX_LIST_ITEMS = 100;
const PROSE_KEYS = ['summary', 'impact', 'triggerNarrative', 'resolution', 'detection'] as const;
const PATCH_KEYS = new Set<string>([
  'revision',
  ...PROSE_KEYS,
  'supportingInformation',
  'contributingCauses',
  'lessons',
  'timeline',
]);

const isTrigger = (value: unknown): value is PostmortemTrigger =>
  typeof value === 'string' && (POSTMORTEM_TRIGGERS as readonly string[]).includes(value);

const boundedText = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= MAX_SECTION_CHARS ? scrubSecrets(value) : null;

const textList = (value: unknown): string[] | null => {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return null;
  const out: string[] = [];
  for (const entry of value) {
    const text = boundedText(entry);
    if (text === null) return null;
    out.push(text);
  }
  return out;
};

function parseCauses(value: unknown): ContributingCause[] | null {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return null;
  const out: ContributingCause[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const { cause, evidenceIds } = entry as { cause?: unknown; evidenceIds?: unknown };
    const text = boundedText(cause);
    if (text === null) return null;
    const ids = evidenceIds === undefined ? [] : evidenceIds;
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && UUID_RE.test(id)))
      return null;
    out.push({ cause: text, evidenceIds: ids as string[] });
  }
  return out;
}

function parseLessons(value: unknown): PostmortemLessons | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const wentWell = textList(raw.wentWell);
  const wentWrong = textList(raw.wentWrong);
  const lucky = textList(raw.lucky);
  return wentWell && wentWrong && lucky ? { wentWell, wentWrong, lucky } : null;
}

function parseTimeline(value: unknown): PostmortemTimelineEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return null;
  const out: PostmortemTimelineEntry[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const { at, event } = entry as { at?: unknown; event?: unknown };
    const text = boundedText(event);
    if (typeof at !== 'string' || at.length > POSTMORTEM_TIMELINE_AT_MAX_CHARS || text === null)
      return null;
    out.push({ at: scrubSecrets(at), event: text });
  }
  return out;
}

/** Parses a PATCH body into the revision it presents and the scrubbed sections it replaces. */
export function parsePostmortemPatch(
  value: unknown,
): { revision: number; patch: Partial<PostmortemSections> } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!Number.isInteger(body.revision) || (body.revision as number) < 1) return null;
  const patch: Partial<PostmortemSections> = {};
  for (const key of PROSE_KEYS) {
    if (body[key] === undefined) continue;
    const text = boundedText(body[key]);
    if (text === null || !text.trim()) return null;
    patch[key] = text;
  }
  if (body.supportingInformation !== undefined) {
    if (body.supportingInformation === null) patch.supportingInformation = null;
    else {
      const text = boundedText(body.supportingInformation);
      if (text === null) return null;
      patch.supportingInformation = text;
    }
  }
  if (body.contributingCauses !== undefined) {
    const causes = parseCauses(body.contributingCauses);
    if (!causes) return null;
    patch.contributingCauses = causes;
  }
  if (body.lessons !== undefined) {
    const lessons = parseLessons(body.lessons);
    if (!lessons) return null;
    patch.lessons = lessons;
  }
  if (body.timeline !== undefined) {
    const timeline = parseTimeline(body.timeline);
    if (!timeline) return null;
    patch.timeline = timeline;
  }
  if (Object.keys(body).some((key) => !PATCH_KEYS.has(key))) return null;
  if (Object.keys(patch).length === 0) return null;
  return { revision: body.revision as number, patch };
}

/**
 * Registers the postmortem document commands: generate (a durable job, no LLM on the request path),
 * read, revision-checked edit, and one-way publish that enqueues the assessment grade in the same
 * transaction.
 */
export function registerIncidentPostmortemRoutes(
  app: Hono<{ Variables: TenantAuthVariables }>,
  deps: IncidentRouteDeps,
): void {
  app.post('/:id/postmortem/generate', async (c) => {
    if (!deps.runbookQueue) return c.json({ error: 'postmortem generation not configured' }, 503);
    const { tenantId, userId } = c.get('tenant');
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'incident not found' }, 404);
    let trigger: unknown;
    try {
      trigger = ((await c.req.json()) as { trigger?: unknown }).trigger;
    } catch {
      trigger = undefined;
    }
    if (!isTrigger(trigger)) return c.json({ error: 'invalid postmortem trigger' }, 400);
    if (!(await getIncidentSummary(deps.db, tenantId, id)))
      return c.json({ error: 'incident not found' }, 404);
    if ((await getPostmortemStatus(deps.db, tenantId, id))?.status === 'published')
      return c.json({ error: 'postmortem already published' }, 409);
    try {
      const jobId = await deps.runbookQueue.enqueue({
        tenantId,
        type: 'postmortem.generate',
        payload: { incidentId: id, trigger, requestedByUserId: userId ?? null },
      });
      return c.json({ jobId }, 202);
    } catch (error) {
      if (error instanceof IncidentUnavailableError)
        return c.json({ error: 'incident not found' }, 404);
      if (error instanceof IncidentMovedError)
        return c.json(
          {
            error: 'incident was joined into another investigation',
            targetIncidentId: error.targetIncidentId,
          },
          409,
        );
      throw error;
    }
  });

  app.get('/:id/postmortem', async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'postmortem not found' }, 404);
    const detail = await getPostmortemDetail(deps.db, c.get('tenant').tenantId, id);
    return detail ? c.json(detail) : c.json({ error: 'postmortem not found' }, 404);
  });

  app.patch('/:id/postmortem', async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'postmortem not found' }, 404);
    const { tenantId } = c.get('tenant');
    let parsed: ReturnType<typeof parsePostmortemPatch> = null;
    try {
      parsed = parsePostmortemPatch(await c.req.json());
    } catch {
      parsed = null;
    }
    if (!parsed) return c.json({ error: 'invalid postmortem edit' }, 400);
    const outcome = await updatePostmortemSections(
      deps.db,
      tenantId,
      id,
      parsed.revision,
      parsed.patch,
    );
    switch (outcome) {
      case 'not_found':
        return c.json({ error: 'postmortem not found' }, 404);
      case 'stale':
        return c.json({ error: 'postmortem changed since it was read; reload and retry' }, 409);
      case 'published':
        return c.json({ error: 'postmortem already published' }, 409);
      case 'updated':
        return c.json(await getPostmortemDetail(deps.db, tenantId, id));
    }
  });

  app.post('/:id/postmortem/publish', async (c) => {
    if (!deps.runbookQueue) return c.json({ error: 'postmortem grading not configured' }, 503);
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'postmortem not found' }, 404);
    const { tenantId, userId } = c.get('tenant');
    if (!userId) return c.json({ error: 'an attributed responder is required' }, 403);
    const queue = deps.runbookQueue;
    let result: Awaited<ReturnType<typeof publishPostmortem>>;
    try {
      result = await publishPostmortem(deps.db, tenantId, id, {
        publishedByUserId: userId,
        enqueueGradeTx: (tx, payload) =>
          queue.insertJobTx(tx, { tenantId, type: 'assessment.grade', payload }),
      });
    } catch (error) {
      if (error instanceof IncidentUnavailableError)
        return c.json({ error: 'incident not found' }, 404);
      if (error instanceof IncidentMovedError)
        return c.json({ error: 'incident was joined into another investigation' }, 409);
      throw error;
    }
    if (result.outcome === 'not_found') return c.json({ error: 'postmortem not found' }, 404);
    if (result.outcome === 'already_published')
      return c.json({ error: 'postmortem already published' }, 409);
    // Post-commit dispatch is best effort: a lost doorbell is re-dispatched by reconcile.
    if (result.jobId) {
      const jobId = result.jobId;
      void queue.publishJob(jobId).catch((error: unknown) => {
        deps.log?.error('Assessment grade publish failed; durable job remains queued', {
          incidentId: id,
          jobId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return c.json({ published: true, gradeJobId: result.jobId }, 200);
  });
}
