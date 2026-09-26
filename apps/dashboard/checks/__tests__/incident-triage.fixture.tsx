import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { LiveIncidentConversation } from '../../src/components/incident-conversation/live';
import { checks, triageWorkspace } from './incident-triage-data.fixture';
import '../../src/index.css';
import { IncidentsList } from '../../src/components/IncidentsList';

const query = new URLSearchParams(location.search);
const theme = query.get('theme');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
let workspace = query.has('provider-resolved')
  ? {
      ...triageWorkspace,
      incident: {
        ...triageWorkspace.incident,
        status: 'resolved',
        resolutionPolicy: 'provider_clear' as const,
        resolutionBasis: 'provider_clear' as const,
        recoveryState: 'verified' as const,
        recoveryUpdatedAt: '2026-09-14T01:00:00Z',
      },
    }
  : query.has('recovered')
    ? {
        ...triageWorkspace,
        incident: {
          ...triageWorkspace.incident,
          recoveryState: 'verified' as const,
          recoveryUpdatedAt: '2026-09-14T01:00:00Z',
          recoverySummary: 'Checkout probes now succeed.',
          latestInvestigationRun: {
            id: 'reviewed-run',
            operation: 'resume' as const,
            outcome: 'inconclusive' as const,
            summary: 'The restart cause remains unproven.',
            triggerReason: null,
            triggerAutomatic: false,
            triggerMonitorKey: null,
            triggerMonitorKeys: [],
            triggerBudget: null,
            completedAt: '2026-09-14T00:45:00Z',
          },
        },
      }
    : triageWorkspace;
const recoveryVariant = query.get('recovery');
if (['blockers', 'follow-up', 'legacy', 'review-failed'].includes(recoveryVariant ?? '')) {
  const followUp = {
    question: 'What caused the original transient failure?',
    category: 'historical_gap' as const,
    evidenceKind: 'logs' as const,
    attemptedEvidenceIds: [checks[0]!.id],
    resolutionRelevance: 'follow_up' as const,
    nextAction: 'Review retained rollout events for recurrence prevention.',
  };
  const blocker = {
    question: 'Is checkout-api ready after the rollout?',
    category: 'missing_capability' as const,
    evidenceKind: 'runtime_state' as const,
    attemptedEvidenceIds: [checks[8]!.id],
    resolutionRelevance: 'blocking' as const,
    nextAction: 'Restore Kubernetes read access and verify all checkout-api replicas are ready.',
  };
  const reviewerFailure = {
    question: 'Evidence review chunk output budget exceeded; coverage is incomplete.',
    category: 'partial_evidence' as const,
    evidenceKind: null,
    attemptedEvidenceIds: [checks[1]!.id],
    resolutionRelevance: 'blocking' as const,
    nextAction:
      'Request a focused recovery check for the affected service with a smaller evidence window.',
  };
  const questions =
    recoveryVariant === 'legacy'
      ? null
      : recoveryVariant === 'follow-up'
        ? [followUp]
        : recoveryVariant === 'review-failed'
          ? [reviewerFailure]
          : [blocker, followUp];
  workspace = {
    ...workspace,
    incident: {
      ...workspace.incident,
      status: recoveryVariant === 'follow-up' ? 'resolved' : 'open',
      recoveryState: recoveryVariant === 'follow-up' ? 'verified' : 'not_verified',
      recoverySummary:
        recoveryVariant === 'review-failed'
          ? 'Recovery review could not complete.'
          : recoveryVariant === 'follow-up'
            ? 'Checkout probes now meet the configured recovery criteria.'
            : 'One current health question remains.',
      recoveryUpdatedAt: '2026-09-14T01:00:00Z',
      recoveryQuestions: questions,
      recoveryUnknowns: questions?.map((question) => question.question) ?? [
        'The historical report did not classify its remaining questions.',
      ],
      recoveryEvidenceIds: [checks[1]!.id],
      recoveryNextStep: null,
    },
  };
}
const credentials = async () => ({ kind: 'bearer' as const, token: 'isolated-fixture' });
const root = createRoot(document.getElementById('root')!);
async function refreshWorkspace() {
  const state = await fetch('/__api/policy').then((response) => response.json());
  workspace = {
    ...workspace,
    incident: {
      ...workspace.incident,
      resolutionPolicy: state.resolutionPolicy,
      lifecycleVersion: state.lifecycleVersion,
    },
  };
  renderFixture();
}
function renderFixture() {
  root.render(
    <BrowserRouter>
      <div className="flex h-dvh min-w-0 bg-canvas text-ink">
        <aside className="hidden w-60 shrink-0 border-r border-line p-5 lg:block">
          <p className="font-semibold">SRE Platform</p>
          <p className="mt-5">Incident response</p>
          <p className="mt-3 text-xs text-ink-muted">Isolated browser fixture</p>
        </aside>
        <main id="main-content" className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mb-4 flex flex-wrap gap-3 text-xs">
            <button className="min-h-11 underline" onClick={() => void fetch('/__api/disconnect')}>
              Disconnect stream
            </button>
            <button className="min-h-11 underline" onClick={() => void fetch('/__api/publish')}>
              Publish update
            </button>
          </div>
          {query.has('queue') ? (
            <IncidentsList incidents={[{ ...workspace.incident, rcaSummary: null }]} />
          ) : (
            <LiveIncidentConversation
              workspace={
                query.has('long')
                  ? {
                      ...workspace,
                      incident: {
                        ...workspace.incident,
                        title: `Checkout requests ${'across-very-long-resource-identities-'.repeat(12)}`,
                      },
                    }
                  : workspace
              }
              getCredentials={credentials}
              refreshWorkspace={() => void refreshWorkspace()}
              viewerName="Responder"
            />
          )}
        </main>
      </div>
    </BrowserRouter>,
  );
}
renderFixture();
