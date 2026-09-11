// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { DomainDnsVerification } from '../DomainDnsVerification';

afterEach(cleanup);
const domain = {
  id: 'domain',
  providerId: 'provider',
  domain: 'example.test',
  status: 'pending',
  challenge: 'dns-proof',
  expiresAt: null,
  lastCheckedAt: null,
};
const props = { domain, canVerify: true, platformManaged: false, busy: false, checking: false };

test.each([
  ['pending', /matching TXT record is not confirmed/],
  ['verified', /DNS verified/],
  ['expired', /verification proof expired/],
  ['conflict', /conflicting claim/],
] as const)('explains a %s check result', async (status, message) => {
  const onCheck = vi.fn(async () => ({ status }));
  render(<DomainDnsVerification {...props} onCheck={onCheck} />);
  fireEvent.click(screen.getByRole('button', { name: 'Verify DNS now' }));
  expect(await screen.findByText(message)).toBeDefined();
  expect(onCheck).toHaveBeenCalledTimes(1);
});

test('shows a retryable error without displaying raw server details', async () => {
  render(
    <DomainDnsVerification
      {...props}
      onCheck={async () => {
        throw Error('internal details');
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Verify DNS now' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'DNS verification could not complete',
  );
  expect(screen.queryByText(/internal details/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Verify DNS now' })).toBeDefined();
});

test.each([false, true])(
  'explains unavailable verification for platform-managed=%s domains',
  (platformManaged) => {
    render(
      <DomainDnsVerification
        {...props}
        canVerify={false}
        platformManaged={platformManaged}
        onCheck={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(
      screen.getByText(platformManaged ? /managed by the platform/ : /Ask the workspace owner/),
    ).toBeDefined();
  },
);
