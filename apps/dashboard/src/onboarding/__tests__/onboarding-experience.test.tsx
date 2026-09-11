// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../theme';
import { WorkspaceIdentityPage } from '../WorkspaceIdentityPage';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

function renderWorkspaceIdentity() {
  render(
    <ThemeProvider>
      <MemoryRouter>
        <WorkspaceIdentityPage onContinue={() => {}} />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('workspace setup preparation', () => {
  test('updates the suggested address while typing until the address is edited manually', () => {
    renderWorkspaceIdentity();
    const name = screen.getByLabelText('Workspace name');
    const address = screen.getByLabelText('Workspace address') as HTMLInputElement;
    const workspaceName = 'Acme Engineering';

    for (let length = 1; length <= workspaceName.length; length++) {
      const typed = workspaceName.slice(0, length);
      fireEvent.change(name, { target: { value: typed } });
      expect(address.value).toBe(typed.trim().toLowerCase().replace(/\s+/g, '-'));
    }

    fireEvent.change(address, { target: { value: 'operations-team' } });
    fireEvent.change(name, { target: { value: 'Acme Operations' } });
    expect(address.value).toBe('operations-team');
  });

  test('previews the complete permanent sign-in URL using the chosen address', () => {
    renderWorkspaceIdentity();
    fireEvent.change(screen.getByLabelText('Workspace name'), {
      target: { value: 'Acme Engineering' },
    });
    fireEvent.change(screen.getByLabelText('Workspace address'), {
      target: { value: 'acme-engineering' },
    });

    expect(screen.getByText(`${window.location.origin}/acme-engineering`)).toBeDefined();
  });

  test('explains the next step and when domain verification happens', () => {
    renderWorkspaceIdentity();

    expect(document.body.textContent).toMatch(/access to your identity provider/);
    expect(document.body.textContent).toMatch(/Domain verification follows workspace creation/);
  });
});
