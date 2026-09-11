import { scrubSecrets } from '@sre/agent-tools';
import {
  ACTION_ITEM_STATES,
  ACTION_ITEM_TYPES,
  ASSESSMENT_VERDICTS,
  hasKnownCredential,
  isSensitiveKey,
  type ActionItemState,
  type AssessmentVerdict,
} from '@sre/contracts';
import {
  ActionItemLimitError,
  createActionItem,
  getAssessmentGradeForRun,
  getPostmortemStatus,
  updateActionItem,
  upsertHumanAssessmentGradeTx,
  withTenant,
  type ActionItemInput,
  type ActionItemPatch,
} from '@sre/db';
import { Hono } from 'hono';
import { type TenantAuthVariables } from '../auth';
import { UUID_RE, type IncidentRouteDeps } from './support';

const MAX_TITLE_CHARS = 500;
const MAX_OWNER_CHARS = 200;
const MAX_URL_CHARS = 2_000;
const MAX_RATIONALE_CHARS = 1_000;

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

/**
 * Accepts only an absolute https URL; anything else (http, javascript, relative) is rejected.
 * Userinfo, a recognised credential anywhere in the URL, and any query or fragment parameter whose
 * name is sensitive (`token`, `private_token`, `password`, ...) are refused rather than redacted:
 * the stored link is rendered to the whole tenant, and a scrubbed URL would be a broken link.
 * The high-entropy heuristic is not applied, so a long opaque path id (a document id) is accepted.
 */
function parseTrackerUrl(value: unknown): string | null | false {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_URL_CHARS) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    // Serialisation can grow the input (percent-encoding), so bound the stored form too.
    const text = url.toString();
    if (text.length > MAX_URL_CHARS || hasKnownCredential(text)) return false;
    // The whole-string pass reads `https:` as the key and its value runs to the end of the URL, so
    // no query key is ever examined there. Check each parameter (query and fragment) on its own.
    const params = [...url.searchParams];
    if (url.hash) params.push(...new URLSearchParams(url.hash.slice(1)));
    for (const [key, param] of params) {
      if (isSensitiveKey(key) || hasKnownCredential(param)) return false;
    }
    return text;
  } catch {
    return false;
  }
}

function parseDueAt(value: unknown): Date | null | false {
  if (value === null) return null;
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? false : date;
}

function parseBounded(value: unknown, max: number): string | false {
  if (typeof value !== 'string') return false;
  const text = scrubSecrets(value.trim());
  return text && text.length <= max ? text : false;
}

/** Parses a create body; `null` means invalid. */
export function parseActionItemInput(value: unknown): ActionItemInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!oneOf(ACTION_ITEM_TYPES, body.type)) return null;
  const title = parseBounded(body.title, MAX_TITLE_CHARS);
  if (title === false) return null;
  const input: ActionItemInput = { type: body.type, title };
  if (body.owner !== undefined && body.owner !== null) {
    const owner = parseBounded(body.owner, MAX_OWNER_CHARS);
    if (owner === false) return null;
    input.owner = owner;
  }
  if (body.trackerUrl !== undefined) {
    const url = parseTrackerUrl(body.trackerUrl);
    if (url === false) return null;
    input.trackerUrl = url;
  }
  if (body.dueAt !== undefined) {
    const dueAt = parseDueAt(body.dueAt);
    if (dueAt === false) return null;
    input.dueAt = dueAt;
  }
  return input;
}

/** Parses an update body; `null` means invalid or empty. */
export function parseActionItemPatch(value: unknown): ActionItemPatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const patch: ActionItemPatch = {};
  if (body.title !== undefined) {
    const title = parseBounded(body.title, MAX_TITLE_CHARS);
    if (title === false) return null;
    patch.title = title;
  }
  if (body.owner !== undefined) {
    if (body.owner === null) patch.owner = null;
    else {
      const owner = parseBounded(body.owner, MAX_OWNER_CHARS);
      if (owner === false) return null;
      patch.owner = owner;
    }
  }
  if (body.trackerUrl !== undefined) {
    const url = parseTrackerUrl(body.trackerUrl);
    if (url === false) return null;
    patch.trackerUrl = url;
  }
  if (body.dueAt !== undefined) {
    const dueAt = parseDueAt(body.dueAt);
    if (dueAt === false) return null;
    patch.dueAt = dueAt;
  }
  if (body.state !== undefined) {
    if (!oneOf(ACTION_ITEM_STATES, body.state)) return null;
    patch.state = body.state as ActionItemState;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Registers action item commands and the responder's own RCA verdict on a postmortem's assessment.
 */
export function registerPostmortemActionItemRoutes(
  app: Hono<{ Variables: TenantAuthVariables }>,
  deps: IncidentRouteDeps,
): void {
  app.post('/:id/postmortem/action-items', async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'postmortem not found' }, 404);
    let input: ActionItemInput | null = null;
    try {
      input = parseActionItemInput(await c.req.json());
    } catch {
      input = null;
    }
    if (!input) return c.json({ error: 'invalid action item' }, 400);
    let item: Awaited<ReturnType<typeof createActionItem>>;
    try {
      item = await createActionItem(deps.db, c.get('tenant').tenantId, id, input);
    } catch (error) {
      if (error instanceof ActionItemLimitError) return c.json({ error: error.message }, 409);
      throw error;
    }
    return item
      ? c.json({ actionItem: item }, 201)
      : c.json({ error: 'postmortem not found' }, 404);
  });

  app.patch('/:id/postmortem/action-items/:itemId', async (c) => {
    const id = c.req.param('id');
    const itemId = c.req.param('itemId');
    if (!UUID_RE.test(id) || !UUID_RE.test(itemId))
      return c.json({ error: 'action item not found' }, 404);
    let patch: ActionItemPatch | null = null;
    try {
      patch = parseActionItemPatch(await c.req.json());
    } catch {
      patch = null;
    }
    if (!patch) return c.json({ error: 'invalid action item' }, 400);
    const item = await updateActionItem(deps.db, c.get('tenant').tenantId, id, itemId, patch);
    return item ? c.json({ actionItem: item }) : c.json({ error: 'action item not found' }, 404);
  });

  // The responder's own three-way verdict on the graded assessment. Attributed (who to ask, never
  // causation); it upserts human_verdict only, leaving the judge's verdict for the agreement rate.
  app.post('/:id/postmortem/grade', async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'postmortem not found' }, 404);
    const { tenantId, userId } = c.get('tenant');
    if (!userId) return c.json({ error: 'an attributed responder is required' }, 403);
    let body: { verdict?: unknown; rationale?: unknown } = {};
    try {
      body = (await c.req.json()) as { verdict?: unknown; rationale?: unknown };
    } catch {
      body = {};
    }
    const rationale = parseBounded(body.rationale, MAX_RATIONALE_CHARS);
    if (!oneOf(ASSESSMENT_VERDICTS, body.verdict) || rationale === false)
      return c.json({ error: 'invalid assessment grade' }, 400);
    const verdict: AssessmentVerdict = body.verdict;
    const status = await getPostmortemStatus(deps.db, tenantId, id);
    if (!status) return c.json({ error: 'postmortem not found' }, 404);
    if (!status.assessmentRunId)
      return c.json({ error: 'no assessment run is pinned to this postmortem' }, 409);
    const runId = status.assessmentRunId;
    const recorded = await withTenant(deps.db, tenantId, (tx) =>
      upsertHumanAssessmentGradeTx(tx, tenantId, {
        incidentId: id,
        runId,
        verdict,
        rationale,
        gradedByUserId: userId,
      }),
    );
    if (!recorded) return c.json({ error: 'the pinned assessment claimed no confidence' }, 409);
    return c.json({ grade: await getAssessmentGradeForRun(deps.db, tenantId, runId) }, 201);
  });
}
