// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  SignalPolicyControls,
  SignalPromotionControls,
  type SignalEvaluation,
  type SignalPolicy,
} from '../SignalControls';

const policy = (): SignalPolicy => ({
  classificationMode: 'shadow',
  retentionDays: 30,
  unsolvedAfterMinutes: 60,
  secondTeamEnabled: true,
  customerVisibleEnabled: true,
  enforcementApprovedAt: null,
  approvedEvaluationId: null,
  approvedCorpusVersion: null,
  approvedContractVersion: null,
  approvedRuntimeFingerprint: null,
});

const evaluation = (
  criticalSafetyMisses: number,
  incorrect = criticalSafetyMisses,
): SignalEvaluation => ({
  id: 'evaluation-1',
  status: 'completed',
  total: 27,
  correct: 27 - incorrect,
  criticalSafetyMisses,
  failureCategory: null,
  completedAt: '2026-09-02T00:00:00.000Z',
  classMetrics: {
    investigate: { expected: 13, predicted: 13, correct: 13, recall: 1, precision: 1 },
    ticket: { expected: 8, predicted: 8, correct: 8, recall: 1, precision: 1 },
    log: { expected: 6, predicted: 6, correct: 6, recall: 1, precision: 1 },
  },
  scenarioResults: [
    {
      id: 'capacity-overcommit',
      message: 'Cluster capacity cannot tolerate a node failure.',
      expected: 'ticket',
      expectedTicket: {
        action: 'Restore headroom.',
        safeDeferralReason: 'No impact now.',
        riskIfIgnored: 'Node loss may cause impact.',
        reviewHorizonMinutes: 60,
      },
      prediction: {
        disposition: 'ticket',
        action: 'Do nothing.',
        safeDeferralReason: 'No reason.',
        riskIfIgnored: 'No risk.',
        reviewHorizonMinutes: 60,
      },
    },
  ],
});

const eligible = { eligible: true, reason: null };
const ineligible = { eligible: false, reason: 'The evaluation has an accuracy miss.' };

describe('SignalControls', () => {
  test('promotion failures hide unclassified diagnostics and leave the action retryable', async () => {
    render(
      <SignalPromotionControls
        secondTeamEnabled
        customerVisibleEnabled
        unsolvedEligible
        onPromote={async () => {
          throw new Error('private diagnostics');
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Declaration criterion'), {
      target: { value: 'customer_visible' },
    });
    fireEvent.change(screen.getByLabelText('Evidence'), {
      target: { value: 'Customer impact confirmed.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Investigate' }));
    expect(await screen.findByText('Ticket could not be promoted.')).toBeDefined();
    expect(document.body.textContent).not.toContain('private diagnostics');
    expect(
      (screen.getByRole('button', { name: 'Investigate' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  test('requires a server-produced zero-miss evaluation before separate enforcement approval', async () => {
    const onSave = vi.fn(async () => {});
    const onRunEvaluation = vi.fn(async () => {});
    const onApprove = vi.fn(async () => {});
    const onReturnToShadow = vi.fn(async () => {});
    const view = render(
      <SignalPolicyControls
        policy={policy()}
        evaluation={null}
        effectiveClassificationMode="shadow"
        enforcementEligibility={ineligible}
        onSave={onSave}
        onRunEvaluation={onRunEvaluation}
        onApprove={onApprove}
        onReturnToShadow={onReturnToShadow}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'Approve enforcement' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Run accuracy evaluation' }));
    await waitFor(() => expect(onRunEvaluation).toHaveBeenCalledOnce());

    view.rerender(
      <SignalPolicyControls
        policy={policy()}
        evaluation={evaluation(1)}
        effectiveClassificationMode="shadow"
        enforcementEligibility={ineligible}
        onSave={onSave}
        onRunEvaluation={onRunEvaluation}
        onApprove={onApprove}
        onReturnToShadow={onReturnToShadow}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'Approve enforcement' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    view.rerender(
      <SignalPolicyControls
        policy={policy()}
        evaluation={evaluation(0, 1)}
        effectiveClassificationMode="shadow"
        enforcementEligibility={ineligible}
        onSave={onSave}
        onRunEvaluation={onRunEvaluation}
        onApprove={onApprove}
        onReturnToShadow={onReturnToShadow}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'Approve enforcement' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    view.rerender(
      <SignalPolicyControls
        policy={policy()}
        evaluation={evaluation(0)}
        effectiveClassificationMode="shadow"
        enforcementEligibility={eligible}
        onSave={onSave}
        onRunEvaluation={onRunEvaluation}
        onApprove={onApprove}
        onReturnToShadow={onReturnToShadow}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'Approve enforcement' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/cluster capacity cannot tolerate a node failure/i)).toBeDefined();
    expect(screen.getByText(/action: restore headroom/i)).toBeDefined();
    expect(screen.getByText(/action: do nothing/i)).toBeDefined();
    fireEvent.click(screen.getByRole('checkbox', { name: /capacity-overcommit/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve enforcement' }));
    await waitFor(() =>
      expect(onApprove).toHaveBeenCalledWith('evaluation-1', ['capacity-overcommit']),
    );
    expect(screen.getByRole('table', { name: 'Classifier accuracy by disposition' })).toBeDefined();
  });

  test('surfaces failed actions and restores controls for retry', async () => {
    const onRunEvaluation = vi.fn(async () => {
      throw new Error('Evaluation dispatch unavailable');
    });
    render(
      <SignalPolicyControls
        policy={policy()}
        evaluation={null}
        effectiveClassificationMode="shadow"
        enforcementEligibility={ineligible}
        onSave={async () => {}}
        onRunEvaluation={onRunEvaluation}
        onApprove={async () => {}}
        onReturnToShadow={async () => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run accuracy evaluation' }));
    expect(await screen.findByText('Signal control action failed.')).toBeDefined();
    expect(document.body.textContent).not.toContain('Evaluation dispatch unavailable');
    expect(
      (screen.getByRole('button', { name: 'Run accuracy evaluation' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  test('requires human evidence and submits the chosen declaration criterion', async () => {
    const onPromote = vi.fn(async () => {});
    render(
      <SignalPromotionControls
        secondTeamEnabled
        customerVisibleEnabled
        unsolvedEligible
        onPromote={onPromote}
      />,
    );
    const submit = screen.getByRole('button', { name: 'Investigate' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Declaration criterion'), {
      target: { value: 'customer_visible' },
    });
    fireEvent.change(screen.getByLabelText('Evidence'), {
      target: { value: 'Checkout errors are confirmed customer-visible.' },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(onPromote).toHaveBeenCalledWith(
        'customer_visible',
        'Checkout errors are confirmed customer-visible.',
      ),
    );
  });
});
