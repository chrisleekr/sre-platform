// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { KubernetesCredentialHelp } from '../KubernetesCredentialHelp';

afterEach(cleanup);

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function openHelp() {
  render(<KubernetesCredentialHelp />);
  fireEvent.click(screen.getByText('How to get your existing token and CA (PEM)'));
}

test('guides namespace and token Secret discovery before showing decoded token and PEM commands', () => {
  openHelp();
  expect(screen.getByText('kubectl config current-context')).toBeDefined();
  expect(screen.queryByText(/get secrets --field-selector/)).toBeNull();
  fill('Service account namespace', 'observability');
  expect(screen.getByText(/get secrets --field-selector/).textContent).toBe(
    "kubectl -n 'observability' get secrets --field-selector=type=kubernetes.io/service-account-token -o 'custom-columns=SECRET:.metadata.name,SERVICE_ACCOUNT:.metadata.annotations.kubernetes\\.io/service-account\\.name'",
  );
  fill('Token Secret name', 'reader-token');
  expect(
    screen.getByText(
      "kubectl -n 'observability' get secret 'reader-token' -o jsonpath='{.data.token}' | base64 -d",
    ),
  ).toBeDefined();
  expect(
    screen.getByText(
      "kubectl -n 'observability' get secret 'reader-token' -o jsonpath='{.data.ca\\.crt}' | base64 -d",
    ),
  ).toBeDefined();
  expect(screen.getByText(/public CA certificate, not a private key/)).toBeDefined();
});

test('changing namespace clears names so commands cannot silently target another namespace', () => {
  openHelp();
  fill('Service account namespace', 'first');
  fill('Token Secret name', 'reader-token');
  fireEvent.click(screen.getByText('No token Secret listed?'));
  fill('Existing service account name', 'reader');
  fill('Service account namespace', 'second');
  expect(screen.getByLabelText('Token Secret name')).toHaveProperty('value', '');
  expect(screen.getByLabelText('Existing service account name')).toHaveProperty('value', '');
  expect(screen.queryByText(/get secret 'reader-token'/)).toBeNull();
  expect(screen.queryByText(/create token 'reader'/)).toBeNull();
});

test.each(["bad'; touch injected", '$(whoami)', '--all-namespaces', 'bad name'])(
  'does not interpolate unsafe names into commands: %j',
  (value) => {
    openHelp();
    fill('Service account namespace', value);
    expect(screen.queryByText(/get secrets --field-selector/)).toBeNull();
    fill('Service account namespace', 'observability');
    fill('Token Secret name', value);
    expect(screen.queryByText(/jsonpath='\{.data.token\}'/)).toBeNull();
    fireEvent.click(screen.getByText('No token Secret listed?'));
    fill('Existing service account name', value);
    expect(screen.queryByText(/create token/)).toBeNull();
  },
);

test('offers a temporary same-account token with an expiry warning and a separate CA command', () => {
  openHelp();
  fill('Service account namespace', 'observability');
  fireEvent.click(screen.getByText('No token Secret listed?'));
  fill('Existing service account name', 'reader');
  expect(
    screen.getByText("kubectl -n 'observability' create token 'reader' --duration=1h"),
  ).toBeDefined();
  expect(screen.getByText(/does not renew it/)).toBeDefined();
  expect(
    screen.getByText(
      "kubectl -n 'observability' get configmap kube-root-ca.crt -o jsonpath='{.data.ca\\.crt}'",
    ),
  ).toBeDefined();
});
