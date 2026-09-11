import * as z from 'zod';
import {
  ACTION_ITEM_TYPES,
  POSTMORTEM_TIMELINE_AT_MAX_CHARS,
  POSTMORTEM_TRIGGERS,
  type PostmortemSections,
  type PostmortemTrigger,
} from '@sre/contracts';
import {
  getIncident,
  getPostmortemStatus,
  listTenantMembers,
  saveGeneratedPostmortem,
  type Db,
  type GeneratedPostmortemInput,
} from '@sre/db';
import { RetryableError, type Job, type JobContext } from '@sre/queue';
import type { NewMessage } from '@sre/hub';
import {
  BLAMELESS_SYSTEM_PROMPT,
  collectHumanIdentifiers,
  stripHumanIdentifiers,
} from './blameless';
import { ProviderUnavailableError, type StructuredGenerator } from './engine/types';
import type { LlmRuntimeManager } from './llm-runtime';
import { publicModelText } from './public-output';

// Same redelivery ceiling as the runbook consumer: a sustained provider outage posts "generation
// failed" (dashboard-only) and ACKS before the queue dead-letters. Never fails the incident.
const FAIL_MAX = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Per-generation cap on model output, trimmed rather than failing the draft. The per-postmortem cap
// (MAX_ACTION_ITEMS in @sre/db) is enforced by saveGeneratedPostmortem, which counts surviving rows.
const MAX_GENERATED_ACTION_ITEMS = 25;

// Domain schema stays with the consumer; the generator binding is domain-agnostic.
// Bounds mirror the PATCH validator: the dashboard saves the whole document, so a draft the API
// would reject (blank prose, an over-long timeline `at`) could never be edited at all.
const prose = z.string().min(1);
const PostmortemSchema = z.object({
  summary: prose,
  impact: prose,
  contributingCauses: z.array(z.object({ cause: prose, evidenceIds: z.array(z.string()) })),
  triggerNarrative: prose,
  resolution: prose,
  detection: prose,
  lessons: z.object({
    wentWell: z.array(prose),
    wentWrong: z.array(prose),
    lucky: z.array(prose),
  }),
  timeline: z.array(
    z.object({ at: z.string().max(POSTMORTEM_TIMELINE_AT_MAX_CHARS), event: z.string() }),
  ),
  supportingInformation: z.string().nullable(),
  actionItems: z.array(z.object({ type: z.enum(ACTION_ITEM_TYPES), title: z.string() })),
});
type PostmortemDraft = z.infer<typeof PostmortemSchema>;

export interface IncidentForPostmortem {
  service: string;
  severity: string;
  status: string;
  title: string | null;
  rcaSummary: string | null;
  confidence: number | null;
  rankedHypotheses: unknown;
  assessmentEvidenceIds: string[] | null;
  trustedAssessmentRunId: string | null;
  deployCorrelated: boolean;
  createdAt: Date;
  mitigatedAt: Date | null;
  resolvedAt: Date | null;
  archivedAt: Date | null;
}

type Transcript = { author: string; kind: string; content: string; createdAt?: string }[];

type GetIncidentFn = (tenantId: string, id: string) => Promise<IncidentForPostmortem | null>;
type GetStatusFn = (
  tenantId: string,
  incidentId: string,
) => Promise<{ status: 'draft' | 'published' } | null>;
type ListMemberEmailsFn = (tenantId: string) => Promise<string[]>;
type SaveFn = (
  tenantId: string,
  incidentId: string,
  input: GeneratedPostmortemInput,
) => Promise<'saved' | 'published'>;

interface HubLike {
  append(tenantId: string, incidentId: string, msg: NewMessage): Promise<unknown>;
  history?(tenantId: string, incidentId: string): Promise<Transcript>;
}

export interface PostmortemHandlerDeps {
  llm?: LlmRuntimeManager;
  generator?: StructuredGenerator;
  hub: HubLike;
  appDb: Db;
  // Injectable, default to @sre/db bound to appDb. Tests inject spies to stay hermetic.
  getIncident?: GetIncidentFn;
  getPostmortemStatus?: GetStatusFn;
  listMemberEmails?: ListMemberEmailsFn;
  saveGeneratedPostmortem?: SaveFn;
}

class TerminalGenerationError extends Error {}

// `min(1)` admits whitespace-only prose, which publicModelText would turn into its fallback sentence.
const isBlank = (text: string): boolean => text.trim().length === 0;
const nonBlank = (text: string): boolean => !isBlank(text);
const hasBlankProse = (draft: PostmortemDraft): boolean =>
  [draft.summary, draft.impact, draft.triggerNarrative, draft.resolution, draft.detection].some(
    isBlank,
  ) || draft.contributingCauses.some((cause) => isBlank(cause.cause));

// The API cap counts UTF-16 units (parseTimeline uses `.length`), so slice in units, but a cut
// through a surrogate pair leaves a lone high surrogate that jsonb rejects.
function boundAt(text: string): string {
  const out = text.slice(0, POSTMORTEM_TIMELINE_AT_MAX_CHARS);
  return /[\uD800-\uDBFF]$/u.test(out) ? out.slice(0, -1) : out;
}

const isTrigger = (value: unknown): value is PostmortemTrigger =>
  typeof value === 'string' && (POSTMORTEM_TRIGGERS as readonly string[]).includes(value);

function renderTranscript(transcript: Transcript): string {
  if (transcript.length === 0) return '';
  const lines = transcript.map(
    (m) => `[${m.createdAt ? `${m.createdAt} ` : ''}${m.author}/${m.kind}] ${m.content}`,
  );
  return `Incident conversation, tool activity and lifecycle events, oldest first:\n${lines.join('\n')}`;
}

function buildPrompt(
  incident: IncidentForPostmortem,
  trigger: PostmortemTrigger,
  transcript: Transcript,
): string {
  return [
    'Write the postmortem for this incident. Fill every section; keep the timeline to dated events from',
    'the material; cite evidence ids only from the list given; propose typed action items without owners.',
    '',
    `Declared postmortem trigger: ${trigger}.`,
    `Service: ${incident.service} (severity ${incident.severity}, lifecycle ${incident.status}).`,
    `Title: ${incident.title ?? '(none)'}.`,
    `Opened: ${incident.createdAt.toISOString()}; mitigated: ${incident.mitigatedAt?.toISOString() ?? 'not recorded'}; resolved: ${incident.resolvedAt?.toISOString() ?? 'not recorded'}.`,
    `Deploy correlated: ${incident.deployCorrelated ? 'yes' : 'no'}.`,
    `Root-cause assessment: ${incident.rcaSummary ?? '(none recorded)'} (claimed confidence ${incident.confidence ?? 'none'}).`,
    `Ranked hypotheses: ${JSON.stringify(incident.rankedHypotheses ?? [])}.`,
    `Evidence ids available for citation: ${JSON.stringify(incident.assessmentEvidenceIds ?? [])}.`,
    renderTranscript(transcript),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Postmortem-generation consumer on the `sre:runbook` stream, invoked by a human command
 * (POST /incidents/:id/postmortem/generate). One StructuredGenerator call under the blameless system
 * prompt, then the identifier guard over every prose field, then a draft write that never touches a
 * published document and keeps human-added action items. Posts a mirrored `postmortem` hub line on
 * success and a dashboard-only failure note after bounded retries. Never touches `incidents`.
 */
export function makePostmortemHandler(
  deps: PostmortemHandlerDeps,
): (job: Job, ctx?: JobContext) => Promise<void> {
  const { appDb, generator, hub } = deps;
  const getInc: GetIncidentFn =
    deps.getIncident ?? ((tenantId, id) => getIncident(appDb, tenantId, id));
  const getStatus: GetStatusFn =
    deps.getPostmortemStatus ??
    ((tenantId, incidentId) => getPostmortemStatus(appDb, tenantId, incidentId));
  const listEmails: ListMemberEmailsFn =
    deps.listMemberEmails ??
    (async (tenantId) =>
      (await listTenantMembers(appDb, tenantId))
        .map((member) => member.email)
        .filter((email): email is string => typeof email === 'string'));
  const save: SaveFn =
    deps.saveGeneratedPostmortem ??
    ((tenantId, incidentId, input) => saveGeneratedPostmortem(appDb, tenantId, incidentId, input));

  const post = (tenantId: string, incidentId: string, content: string): Promise<unknown> =>
    hub.append(tenantId, incidentId, { author: 'system', kind: 'text', content });

  return async (
    job: Job,
    ctx: JobContext = { signal: new AbortController().signal },
  ): Promise<void> => {
    if (job.type !== 'postmortem.generate') return;
    const payload = job.payload as {
      incidentId: string;
      trigger?: unknown;
      requestedByUserId?: unknown;
    };
    const { incidentId, trigger } = payload;
    const tenantId = job.tenantId;
    const { signal } = ctx;
    const requestedByUserId =
      typeof payload.requestedByUserId === 'string' && UUID_RE.test(payload.requestedByUserId)
        ? payload.requestedByUserId
        : null;

    const incident = await getInc(tenantId, incidentId);
    if (!incident || incident.archivedAt) return;

    // The trigger is a responder's declaration (Ch 15); a malformed job is refused, never given one.
    if (!isTrigger(trigger)) {
      await post(
        tenantId,
        incidentId,
        'Postmortem generation was refused: no valid trigger was declared.',
      );
      return;
    }

    // A published postmortem is final: no-op BEFORE any LLM call.
    if ((await getStatus(tenantId, incidentId))?.status === 'published') {
      await post(tenantId, incidentId, 'This incident’s postmortem is already published.');
      return;
    }

    const transcript = hub.history ? await hub.history(tenantId, incidentId) : [];
    const prompt = buildPrompt(incident, trigger, transcript);
    const identifiers = collectHumanIdentifiers(await listEmails(tenantId), prompt);
    const clean = (text: string): string =>
      stripHumanIdentifiers(publicModelText(text), identifiers);
    const allowedEvidence = new Set(incident.assessmentEvidenceIds ?? []);

    const gen = async (): Promise<PostmortemDraft> => {
      try {
        if (deps.llm) {
          return await deps.llm.execute(
            { tenantId, incidentId, jobId: job.id, operation: 'postmortem-generate', signal },
            ({ generator: current }) =>
              current.generate(prompt, PostmortemSchema, {
                system: BLAMELESS_SYSTEM_PROMPT,
                signal,
              }),
          );
        }
        if (!generator) throw new Error('postmortem generator is not configured');
        return await generator.generate(prompt, PostmortemSchema, {
          system: BLAMELESS_SYSTEM_PROMPT,
          signal,
        });
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        if (err instanceof ProviderUnavailableError && job.attempts < FAIL_MAX) {
          throw new RetryableError('postmortem generation provider unavailable');
        }
        throw new TerminalGenerationError();
      }
    };

    try {
      const draft = await gen();
      if (hasBlankProse(draft)) throw new TerminalGenerationError();
      const sections: PostmortemSections = {
        summary: clean(draft.summary),
        impact: clean(draft.impact),
        contributingCauses: draft.contributingCauses.map((cause) => ({
          cause: clean(cause.cause),
          evidenceIds: cause.evidenceIds.filter((id) => allowedEvidence.has(id)),
        })),
        triggerNarrative: clean(draft.triggerNarrative),
        resolution: clean(draft.resolution),
        detection: clean(draft.detection),
        // Blank list entries are dropped, not refused: unlike the prose fields they carry nothing a
        // responder would miss, and clean() would otherwise turn each into the fallback sentence.
        lessons: {
          wentWell: draft.lessons.wentWell.filter(nonBlank).map(clean),
          wentWrong: draft.lessons.wentWrong.filter(nonBlank).map(clean),
          lucky: draft.lessons.lucky.filter(nonBlank).map(clean),
        },
        // clean() can lengthen `at` (a mention becomes "a responder"), so re-bound it to the PATCH cap.
        timeline: draft.timeline
          .filter((entry) => nonBlank(entry.event))
          .map((entry) => ({ at: boundAt(clean(entry.at)), event: clean(entry.event) })),
        supportingInformation:
          draft.supportingInformation && nonBlank(draft.supportingInformation)
            ? clean(draft.supportingInformation)
            : null,
      };
      const saved = await save(tenantId, incidentId, {
        ...sections,
        trigger,
        assessmentRunId: incident.trustedAssessmentRunId,
        requestedByUserId,
        // Untracked by construction: the model cannot know the tenant's tracker or owners. Blank
        // titles go before the slice so they never consume a slot.
        actionItems: draft.actionItems
          .filter((item) => nonBlank(item.title))
          .slice(0, MAX_GENERATED_ACTION_ITEMS)
          .map((item) => ({ type: item.type, title: clean(item.title) })),
      });
      if (saved === 'published') {
        await post(tenantId, incidentId, 'This incident’s postmortem is already published.');
        return;
      }
      await hub.append(tenantId, incidentId, {
        author: 'system',
        kind: 'postmortem',
        content: 'Postmortem draft ready for review.',
        originMessageId: `postmortem:${job.id}`,
      });
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      if (err instanceof TerminalGenerationError) {
        // Terminal generator failure: dashboard-only note + ack, never fail the incident.
        await post(
          tenantId,
          incidentId,
          'Postmortem generation failed after repeated attempts; please try again later.',
        );
        return;
      }
      throw err; // RetryableError (redeliver) or a DB error (queue retries) propagate.
    }
  };
}
