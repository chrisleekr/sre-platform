// @vitest-environment jsdom
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
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
