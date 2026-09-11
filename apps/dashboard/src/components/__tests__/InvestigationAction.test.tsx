// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { installDialogMethods } from '../../test/dialog';

let dialogMethods: ReturnType<typeof installDialogMethods>;
beforeEach(() => {
  dialogMethods = installDialogMethods();
});
afterEach(() => {
  cleanup();
  dialogMethods.restore();
});
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ComponentProps } from 'react';
import { InvestigationAction } from '../InvestigationAction';

const subject = {
  kind: 'infrastructure_resource' as const,
  dataSourceId: '00000000-0000-4000-8000-000000000281',
  entityId: 'argocd/argocd-server-7d9f',
};

const preview = {
  title: 'Argo CD pod restarted after OOM kill',
  source: 'Primary Kubernetes · argocd/argocd-server-7d9f',
  condition: 'Running and ready, one prior OOMKilled termination',
  severity: 'SEV3',
};

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function renderAction(props: Partial<ComponentProps<typeof InvestigationAction>> = {}) {
  const declareInvestigation = vi.fn(async () => ({
    outcome: 'created' as const,
    incidentId: '00000000-0000-4000-8000-000000000901',
  }));
  render(
    <MemoryRouter initialEntries={['/infrastructure']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <InvestigationAction
                subject={subject}
                preview={preview}
                declareInvestigation={declareInvestigation}
                {...props}
              />
              <Location />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { declareInvestigation };
}

describe('InvestigationAction', () => {
  test('confirms exact server-owned context, discloses model cost, and navigates after declaration', async () => {
    let resolveDeclaration!: (value: { outcome: 'created'; incidentId: string }) => void;
    const declareInvestigation = vi.fn(
      () =>
        new Promise<{ outcome: 'created'; incidentId: string }>((resolve) => {
          resolveDeclaration = resolve;
        }),
    );
    renderAction({ declareInvestigation });

    fireEvent.click(screen.getByRole('button', { name: 'Investigate' }));
    const dialog = screen.getByRole('dialog', { name: /start investigation/i });
    expect(dialog.textContent).toContain(preview.title);
    expect(dialog.textContent).toContain(preview.source);
    expect(dialog.textContent).toContain(preview.condition);
    expect(dialog.textContent).toContain(preview.severity);
    expect(dialog.textContent).toMatch(/configured model/i);
    expect(dialog.textContent).toMatch(/usage|cost/i);

    const confirm = screen.getByRole('button', { name: 'Start investigation' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(declareInvestigation).toHaveBeenCalledTimes(1);
    expect(declareInvestigation).toHaveBeenCalledWith(subject);

    resolveDeclaration({
      outcome: 'created',
      incidentId: '00000000-0000-4000-8000-000000000902',
    });
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(
        '/w/incidents/00000000-0000-4000-8000-000000000902',
      ),
    );
  });

  test('opens an active workspace directly without declaring or incurring another model run', () => {
    const { declareInvestigation } = renderAction({
      activeIncidentId: '00000000-0000-4000-8000-000000000903',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open investigation' }));

    expect(declareInvestigation).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe(
      '/w/incidents/00000000-0000-4000-8000-000000000903',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('keeps declaration failures in the confirmation for a safe retry', async () => {
    const declareInvestigation = vi.fn(async () => {
      throw new Error('Current observation is no longer actionable.');
    });
    renderAction({ declareInvestigation });

    fireEvent.click(screen.getByRole('button', { name: 'Investigate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start investigation' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Current observation is no longer actionable.',
    );
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(
      (screen.getByRole('button', { name: 'Start investigation' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByTestId('location').textContent).toBe('/infrastructure');
  });
});
