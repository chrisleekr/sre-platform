import { SetupActions } from './SetupDialogSlots';
import type { KubernetesTestResult } from '../lib/connectors';

export function KubernetesVerification({
  result,
  passed,
  onBack,
  onClose,
}: {
  result: KubernetesTestResult;
  passed: boolean;
  onBack: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className={`font-medium ${passed ? 'text-success' : 'text-critical'}`}>
        {passed
          ? 'Kubernetes connector verified and enabled.'
          : 'Verification failed; the connector remains disabled.'}
      </p>
      <ul className="space-y-1 rounded border border-line p-3 text-sm">
        <li>{result.reachable ? '✓' : '✗'} Cluster reachable</li>
        <li>{result.checks?.canListPods ? '✓' : '✗'} Pods readable</li>
        <li>
          {result.checks?.secretsDenied ? '✓' : '✗'} Secret reads{' '}
          {result.checks?.secretsDenied ? 'denied' : 'allowed'}
        </li>
      </ul>
      {result.warnings.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-warning">
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <SetupActions>
        <button
          type="button"
          onClick={onBack}
          className="rounded border border-line-strong px-3 py-1.5 font-medium"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={!passed}
          className="rounded bg-strong px-3 py-1.5 font-medium text-on-strong disabled:opacity-50"
        >
          Finish
        </button>
      </SetupActions>
    </div>
  );
}
