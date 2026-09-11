import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SetupDialog } from '../../src/components/SetupDialog';
import { SetupActions } from '../../src/components/SetupDialogSlots';
import { SetupProgress } from '../../src/components/SetupProgress';
import { SetupCommand } from '../../src/components/SetupCommand';
import '../../src/index.css';
import { GitLabFlowFixture } from './gitlab-flow.fixture';
import { GitHubRecoveryFixture } from './github-recovery.fixture';
import { KubernetesErrorsFixture } from './kubernetes-errors.fixture';

function Fixture() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [size, setSize] = useState<'compact' | 'standard' | 'wide'>('wide');
  return (
    <main className="p-6">
      <select
        aria-label="Dialog size"
        value={size}
        onChange={(e) => setSize(e.target.value as typeof size)}
      >
        {['compact', 'standard', 'wide'].map((value) => (
          <option key={value}>{value}</option>
        ))}
      </select>
      <button
        onClick={() => {
          setOpen(true);
          setStep(1);
        }}
      >
        Open dialog
      </button>
      {open && (
        <SetupDialog
          title="Connection setup"
          closeLabel="Close"
          size={size}
          onClose={() => setOpen(false)}
        >
          <SetupProgress
            steps={['Server', 'Projects', 'Access', 'Review', 'Verify']}
            current={step}
          />
          <form
            id="modal-layout-form"
            onSubmit={(event) => {
              event.preventDefault();
              setStep(2);
            }}
          >
            <h3 className="mb-4 text-lg font-semibold">
              {step === 1 ? 'Configure access' : 'Review access'}
            </h3>
            <SetupCommand
              command={
                'argocd proj role add-policy default incident-reader --resource applications --action get --object production/checkout-service --permission allow'
              }
              copyLabel="Copy policy command"
            />
            {Array.from({ length: step === 1 ? 30 : 2 }, (_, index) => (
              <label key={index} className="my-4 block">
                Field {index + 1}
                <input
                  className="mt-2 block w-full rounded border p-3"
                  defaultValue={`Resource ${index + 1}`}
                />
              </label>
            ))}
            <SetupActions>
              <button type="button" onClick={() => setStep(1)} disabled={step === 1}>
                Back
              </button>
              <button type="submit" form="modal-layout-form">
                Continue
              </button>
            </SetupActions>
          </form>
        </SetupDialog>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).get('scenario') === 'kubernetes-errors' ? (
    <KubernetesErrorsFixture />
  ) : new URLSearchParams(location.search).get('scenario') === 'gitlab' ? (
    <GitLabFlowFixture />
  ) : new URLSearchParams(location.search).get('scenario') === 'github' ? (
    <GitHubRecoveryFixture />
  ) : (
    <Fixture />
  ),
);
