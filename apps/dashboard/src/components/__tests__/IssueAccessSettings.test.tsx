// @vitest-environment jsdom
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { GitLabConnectWizard } from '../GitLabConnectWizard';
import { installDialogMethods } from '../../test/dialog';
import { IssueAccessSettings } from '../connector-setup/IssueAccessSettings';

function Harness({ provider }: { provider: 'github' | 'gitlab' }) {
  const [value, onChange] = useState({ enabled: false, repositories: [] as string[] });
  const [credential, onCredential] = useState('');
  return (
    <>
      <IssueAccessSettings
        provider={provider}
        value={value}
        onChange={onChange}
        credential={credential}
        onCredential={onCredential}
      />
      <output>{JSON.stringify(value)}</output>
    </>
  );
}

test.each(['github', 'gitlab'] as const)(
  '%s issue access requires opt-in and explicit repository paths',
  (provider) => {
    render(<Harness provider={provider} />);
    expect(screen.queryByLabelText('Repositories allowed for issue changes')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow confirmed issue changes' }));
    fireEvent.change(screen.getByLabelText('Repositories allowed for issue changes'), {
      target: { value: 'team/service\nteam/worker' },
    });
    expect(screen.getByRole('status').textContent).toBe(
      JSON.stringify({ enabled: true, repositories: ['team/service', 'team/worker'] }),
    );
    if (provider === 'gitlab') {
      const input = screen.getByLabelText('Issue-write access token') as HTMLInputElement;
      expect(input.type).toBe('password');
      fireEvent.change(input, { target: { value: 'replacement' } });
      expect(input.value).toBe('replacement');
      expect(screen.getByText(/Keep the discovery token read-only/)).toBeTruthy();
    } else expect(screen.getByText(/Keep other permissions read-only/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow confirmed issue changes' }));
    expect(screen.queryByLabelText('Issue-write access token')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('"enabled":false');
  },
);

test.each(['empty repositories', 'missing token', 'stored token', 'new token'])(
  'GitLab validates issue access before saving: %s',
  async (scenario) => {
    const dialog = installDialogMethods();
    const onSave = vi.fn(async () => ({ connectorId: 'saved', name: 'GitLab', webhookPath: '' }));
    const view = render(
      <GitLabConnectWizard
        mode="edit"
        connectorId="saved"
        credentialConfigured
        apiBaseUrl="https://api.example.com"
        initialSettings={{
          baseUrl: 'https://gitlab.example.com',
          groupId: 7,
          groupPath: 'team',
          eventTransport: 'none',
          issueManagement: {
            enabled: scenario === 'stored token',
            repositories: scenario === 'empty repositories' ? ['  '] : ['team/service'],
          },
        }}
        onDiscover={async () => ({
          group: {
            id: 7,
            name: 'Team',
            fullPath: 'team',
            webUrl: 'https://gitlab.example.com/groups/team',
          },
          projects: [
            {
              id: 71,
              name: 'Service',
              pathWithNamespace: 'team/service',
              webUrl: 'https://gitlab.example.com/team/service',
              archived: false,
            },
          ],
          instance: { version: '19.2.4', enterprise: false },
        })}
        onPrepareDelivery={vi.fn()}
        onSave={onSave}
        onRunTest={async () => ({
          status: 'healthy',
          reachable: true,
          authorized: true,
          warnings: [],
          enabled: true,
        })}
        onClose={vi.fn()}
      />,
    );
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Check access and discover projects' }));
      await screen.findByRole('button', { name: 'Configure event sync' });
      if (scenario !== 'stored token')
        fireEvent.click(screen.getByRole('checkbox', { name: 'Allow confirmed issue changes' }));
      if (scenario === 'new token')
        fireEvent.change(screen.getByLabelText('Issue-write access token'), {
          target: { value: 'write-token' },
        });
      fireEvent.click(screen.getByRole('button', { name: 'Configure event sync' }));
      fireEvent.click(screen.getByRole('button', { name: 'Review' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save and verify' }));
      if (scenario === 'empty repositories' || scenario === 'missing token') {
        expect(
          await screen.findByText(
            scenario === 'empty repositories'
              ? 'Select at least one repository for issue management.'
              : 'Enter an issue-write access token before enabling issue management.',
          ),
        ).toBeTruthy();
        expect(onSave).not.toHaveBeenCalled();
      } else {
        await screen.findByText(/Read access verified/);
        expect(onSave).toHaveBeenCalledTimes(1);
      }
    } finally {
      view.unmount();
      dialog.restore();
    }
  },
);
