import { checkResponse, requestErrorMessage } from '../lib/request-error';
import type {
  ContributingCause,
  PostmortemDetail,
  PostmortemDocument,
  PostmortemLessons,
  PostmortemSections,
} from '@sre/contracts';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useSession } from '../auth';
import { config } from '../config';
import { authenticatedFetch } from '../lib/authenticatedFetch';
import { incidentPath } from '../lib/routes';
import { formatAbsoluteTime } from '../lib/time';
import { useFetchResource } from '../lib/useFetchResource';
import { PageHeader } from './PageHeader';
import { StatePanel } from './PageState';
import { PostmortemActionItems } from './PostmortemActionItems';
import { PostmortemGrade } from './PostmortemGrade';
import { POSTMORTEM_TRIGGER_LABELS } from './incident-conversation/controls';

const POLL_MS = 3_000;
// The worker has paths that never write a row or bump the revision (archived incident, already
// published, terminal generator failure that only posts a hub line). Without a bound the page would
// poll forever, so the wait is bounded by elapsed time, expressed in poll periods (about five
// minutes at POLL_MS), after which the page offers Retry. It is not a count of completed polls.
const WAIT_BOUND_POLLS = 100;
const EMPTY = null as PostmortemDetail | null;
const selectDetail = (body: unknown) => body as PostmortemDetail;

const PROSE_SECTIONS = [
  ['summary', 'Summary'],
  ['impact', 'Impact'],
  ['triggerNarrative', 'Trigger'],
  ['detection', 'Detection'],
  ['resolution', 'Resolution'],
] as const;
const LESSON_LISTS: readonly [keyof PostmortemLessons, string][] = [
  ['wentWell', 'What went well'],
  ['wentWrong', 'What went wrong'],
  ['lucky', 'Where we got lucky'],
];

const TEXTAREA =
  'mt-1 w-full resize-y rounded border border-line-strong bg-surface px-3 py-2 text-sm';
const BUTTON =
  'sre-hit-target rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-semibold text-ink-secondary hover:bg-surface-subtle hover:text-ink disabled:cursor-not-allowed disabled:opacity-60';
const PRIMARY_BUTTON =
  'sre-hit-target rounded-lg bg-strong px-4 py-2 text-sm font-semibold text-on-strong disabled:cursor-not-allowed disabled:opacity-60';

function sectionsOf(doc: PostmortemDocument): PostmortemSections {
  return {
    summary: doc.summary,
    impact: doc.impact,
    contributingCauses: doc.contributingCauses.map((c) => ({
      ...c,
      evidenceIds: [...c.evidenceIds],
    })),
    triggerNarrative: doc.triggerNarrative,
    resolution: doc.resolution,
    detection: doc.detection,
    lessons: {
      wentWell: [...doc.lessons.wentWell],
      wentWrong: [...doc.lessons.wentWrong],
      lucky: [...doc.lessons.lucky],
    },
    timeline: doc.timeline.map((entry) => ({ ...entry })),
    supportingInformation: doc.supportingInformation,
  };
}

/** Lines are the list items; blank lines are dropped so an editor cannot save an empty lesson. */
const splitLines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * One incident's postmortem: polls until the generator has written the draft, then offers revision-
 * checked editing, one-way publish, action item tracking, and the responder's own RCA verdict.
 * `pollMs` is only overridden by tests.
 */
export function PostmortemPage({ pollMs = POLL_MS }: { pollMs?: number } = {}) {
  const { id = '' } = useParams<{ id: string }>();
  const { getCredentials } = useSession();
  const [detail, setDetail] = useState<PostmortemDetail | null>(null);
  const [nonce, setNonce] = useState(0);
  const [reloadPending, setReloadPending] = useState(false);
  // Revision the last regeneration started from; polling continues until the draft moves past it.
  const [regenerateFrom, setRegenerateFrom] = useState<number | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const waiting = !timedOut && (detail === null || regenerateFrom !== null);
  const fetched = useFetchResource<PostmortemDetail | null>({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    path: `/incidents/${encodeURIComponent(id)}/postmortem`,
    initial: EMPTY,
    select: selectDetail,
    pollMs: waiting ? pollMs : undefined,
    nonce,
  });
  // Adopt a fetched document only when the page has none, a reload was asked for, or a
  // regeneration has produced a new revision. Turning polling off refetches once; that read must
  // not clobber a save or a grade the page already holds. The final read after the wait bound
  // fires can still land a document, so adopting one also clears the timeout panel.
  useEffect(() => {
    const next = fetched.data;
    if (!next) return;
    const regenerated = regenerateFrom !== null && next.postmortem.revision !== regenerateFrom;
    if (detail === null || reloadPending || regenerated) {
      setDetail(next);
      setReloadPending(false);
      // Not covered by a test: the final read races the bound timer.
      setTimedOut(false);
      if (regenerated) setRegenerateFrom(null);
    }
  }, [fetched.data, detail, reloadPending, regenerateFrom]);

  // Elapsed-time bound on the wait; the fetch hook exposes no per-poll hook to count against.
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      setTimedOut(true);
      setRegenerateFrom(null);
    }, pollMs * WAIT_BOUND_POLLS);
    return () => clearTimeout(timer);
  }, [waiting, pollMs]);

  const reload = () => {
    setReloadPending(true);
    setNonce((n) => n + 1);
  };
  // Clearing the flag re-arms the bound and, with no document yet, resumes polling.
  const retryWait = () => {
    setTimedOut(false);
    reload();
  };

  return (
    <section className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="Postmortem"
        description="Blameless record of contributing causes and the action items that close them."
        action={
          <Link
            to={incidentPath(id)}
            className="sre-hit-target rounded-md border border-line-strong bg-surface px-3 py-2 text-sm font-semibold text-ink-secondary hover:bg-surface-subtle hover:text-ink"
          >
            Back to incident
          </Link>
        }
      />
      {timedOut && (
        <StatePanel
          state="error"
          title="Postmortem generation did not finish."
          description="Check the incident timeline for a failure note."
          onRetry={retryWait}
        />
      )}
      {!timedOut && detail === null && fetched.errorStatus === 404 && (
        <StatePanel state="loading" title="Generating postmortem…" skeleton="detail" announce />
      )}
      {!timedOut && detail === null && fetched.loading && fetched.errorStatus !== 404 && (
        <StatePanel state="loading" title="Loading postmortem…" skeleton="detail" />
      )}
      {!timedOut && detail === null && fetched.error && fetched.errorStatus !== 404 && (
        <StatePanel state="error" title="Postmortem unavailable." onRetry={reload} />
      )}
      {detail && (
        <PostmortemEditor
          key={`${detail.postmortem.id}:${detail.postmortem.revision}`}
          incidentId={id}
          detail={detail}
          regenerating={regenerateFrom !== null}
          onDetail={setDetail}
          onReload={reload}
          onRegenerate={() => setRegenerateFrom(detail.postmortem.revision)}
        />
      )}
    </section>
  );
}

function PostmortemEditor({
  incidentId,
  detail,
  regenerating,
  onDetail,
  onReload,
  onRegenerate,
}: {
  incidentId: string;
  detail: PostmortemDetail;
  regenerating: boolean;
  onDetail: (detail: PostmortemDetail) => void;
  onReload: () => void;
  onRegenerate: () => void;
}) {
  const { getCredentials } = useSession();
  const { postmortem } = detail;
  const published = postmortem.status === 'published';
  const [sections, setSections] = useState<PostmortemSections>(() => sectionsOf(postmortem));
  const [pending, setPending] = useState<'save' | 'publish' | 'regenerate' | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `${config.apiBaseUrl}/incidents/${encodeURIComponent(incidentId)}/postmortem`;

  const setProse = (key: (typeof PROSE_SECTIONS)[number][0], value: string) =>
    setSections((s) => ({ ...s, [key]: value }));
  const setCause = (index: number, cause: string) =>
    setSections((s) => ({
      ...s,
      contributingCauses: s.contributingCauses.map((c, i) => (i === index ? { ...c, cause } : c)),
    }));
  const setLessons = (key: keyof PostmortemLessons, text: string) =>
    setSections((s) => ({ ...s, lessons: { ...s.lessons, [key]: splitLines(text) } }));

  async function save() {
    if (pending) return;
    setPending('save');
    setError(null);
    try {
      const response = await authenticatedFetch(base, getCredentials, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: postmortem.revision, ...sections }),
      });
      if (response.status === 409) {
        setStale(true);
        return;
      }
      await checkResponse(response, 'Postmortem could not be saved.');
      onDetail((await response.json()) as PostmortemDetail);
    } catch (err) {
      setError(requestErrorMessage(err, 'Postmortem could not be saved.'));
    } finally {
      setPending(null);
    }
  }

  async function publish() {
    if (pending || published) return;
    if (!window.confirm('Publish this postmortem? Publishing is final and grades the assessment.'))
      return;
    setPending('publish');
    setError(null);
    try {
      const response = await authenticatedFetch(`${base}/publish`, getCredentials, {
        method: 'POST',
      });
      await checkResponse(response, 'Postmortem could not be published.');
      onReload();
    } catch (err) {
      setError(requestErrorMessage(err, 'Postmortem could not be published.'));
    } finally {
      setPending(null);
    }
  }

  async function regenerate() {
    if (pending || published) return;
    setPending('regenerate');
    setError(null);
    try {
      const response = await authenticatedFetch(`${base}/generate`, getCredentials, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trigger: postmortem.trigger }),
      });
      await checkResponse(response, 'Postmortem regeneration could not be started.');
      onRegenerate();
    } catch (err) {
      setError(requestErrorMessage(err, 'Postmortem regeneration could not be started.'));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span
          className={`rounded-full px-2 py-0.5 font-semibold ${
            published ? 'bg-success-muted text-success' : 'bg-warning-muted text-warning'
          }`}
        >
          {published ? 'Published' : 'Draft'}
        </span>
        <span className="text-ink-muted">
          Trigger: {POSTMORTEM_TRIGGER_LABELS[postmortem.trigger]}
        </span>
        <span className="text-ink-muted">Revision {postmortem.revision}</span>
        {postmortem.publishedAt && (
          <span className="text-ink-muted">
            Published {formatAbsoluteTime(postmortem.publishedAt)}
          </span>
        )}
        {regenerating && (
          <span role="status" className="text-ink-muted">
            Regenerating draft…
          </span>
        )}
      </div>
      {stale && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning-line bg-warning-soft px-4 py-3 text-sm text-warning"
        >
          <span>
            This postmortem changed since you opened it. Reload to see the latest revision.
          </span>
          <button type="button" onClick={onReload} className={BUTTON}>
            Reload
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
      <section aria-label="Postmortem sections" className="space-y-4">
        {PROSE_SECTIONS.map(([key, label]) => (
          <label key={key} className="block">
            <span className="text-sm font-semibold">{label}</span>
            <textarea
              rows={4}
              value={sections[key]}
              readOnly={published}
              onChange={(event) => setProse(key, event.target.value)}
              className={TEXTAREA}
            />
          </label>
        ))}
        <fieldset>
          <legend className="text-sm font-semibold">Contributing causes</legend>
          {sections.contributingCauses.length === 0 && (
            <p className="text-sm text-ink-muted">No contributing causes recorded.</p>
          )}
          {sections.contributingCauses.map((cause: ContributingCause, index) => (
            <label key={index} className="block">
              <span className="text-xs text-ink-muted">
                Cause {index + 1}
                {cause.evidenceIds.length > 0 && ` · ${cause.evidenceIds.length} evidence`}
              </span>
              <textarea
                rows={2}
                value={cause.cause}
                readOnly={published}
                onChange={(event) => setCause(index, event.target.value)}
                className={TEXTAREA}
              />
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend className="text-sm font-semibold">Lessons learned</legend>
          {LESSON_LISTS.map(([key, label]) => (
            <label key={key} className="block">
              <span className="text-xs text-ink-muted">{label} (one per line)</span>
              <textarea
                rows={3}
                defaultValue={sections.lessons[key].join('\n')}
                readOnly={published}
                onChange={(event) => setLessons(key, event.target.value)}
                className={TEXTAREA}
              />
            </label>
          ))}
        </fieldset>
        <label className="block">
          <span className="text-sm font-semibold">Supporting information</span>
          <textarea
            rows={3}
            value={sections.supportingInformation ?? ''}
            readOnly={published}
            onChange={(event) =>
              setSections((s) => ({ ...s, supportingInformation: event.target.value || null }))
            }
            className={TEXTAREA}
          />
        </label>
        <div>
          <h2 className="text-sm font-semibold">Timeline</h2>
          {sections.timeline.length === 0 ? (
            <p className="text-sm text-ink-muted">No timeline entries.</p>
          ) : (
            <ol className="mt-1 space-y-1 text-sm">
              {sections.timeline.map((entry, index) => (
                <li key={index}>
                  <span className="font-mono text-xs text-ink-muted">{entry.at}</span> {entry.event}
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={published || pending !== null}
          onClick={() => void save()}
          className={BUTTON}
        >
          {pending === 'save' ? 'Saving…' : 'Save postmortem'}
        </button>
        <button
          type="button"
          disabled={published || pending !== null || regenerating}
          onClick={() => void regenerate()}
          className={BUTTON}
        >
          {pending === 'regenerate' ? 'Starting…' : 'Regenerate'}
        </button>
        <button
          type="button"
          disabled={published || pending !== null}
          onClick={() => void publish()}
          className={PRIMARY_BUTTON}
        >
          {published ? 'Published' : pending === 'publish' ? 'Publishing…' : 'Publish'}
        </button>
      </div>
      <PostmortemActionItems
        incidentId={incidentId}
        items={detail.actionItems}
        onChanged={(item) =>
          onDetail({
            ...detail,
            actionItems: detail.actionItems.some((existing) => existing.id === item.id)
              ? detail.actionItems.map((existing) => (existing.id === item.id ? item : existing))
              : [...detail.actionItems, item],
          })
        }
      />
      {published && (
        <PostmortemGrade
          incidentId={incidentId}
          grade={detail.grade}
          onGraded={(grade) => onDetail({ ...detail, grade })}
        />
      )}
    </div>
  );
}
