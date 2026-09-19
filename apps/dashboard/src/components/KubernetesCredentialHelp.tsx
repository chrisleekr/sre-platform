import { useState } from 'react';
import { SetupCommand } from './SetupCommand';

function validName(value: string, namespace = false): boolean {
  return (
    value.length <= (namespace ? 63 : 253) &&
    (namespace ? /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/ : /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/).test(value)
  );
}

export function KubernetesCredentialHelp() {
  const [namespace, setNamespace] = useState('');
  const [secret, setSecret] = useState('');
  const [account, setAccount] = useState('');
  const ns = namespace.trim();
  const secretName = secret.trim();
  const accountName = account.trim();
  const namespaceValid = validName(ns, true);
  const kubectl = `kubectl -n '${ns}'`;

  return (
    <details className="rounded-lg border border-line bg-surface-subtle p-4">
      <summary className="cursor-pointer text-sm font-semibold text-ink">
        How to get your existing token and CA (PEM)
      </summary>
      <div className="mt-4 min-w-0 space-y-4 text-sm">
        <p className="text-ink-muted">
          Run these commands on your computer with authorized kubectl access. They are not run by
          SRE Platform. Never paste credentials into chat or logs.
        </p>
        <section className="space-y-2">
          <h3 className="font-medium">1. Confirm the cluster and find your service account</h3>
          <SetupCommand
            command="kubectl config current-context"
            copyLabel="Copy current context command"
          />
          <SetupCommand
            command="kubectl get serviceaccounts --all-namespaces"
            copyLabel="Copy service account list command"
          />
          <p className="text-xs text-ink-muted">
            Use the context for the API server entered in Cluster. Choose the existing read-only
            service account, not an administrator account. Its namespace can differ from the
            namespace you want to monitor.
          </p>
          <label className="block font-medium">
            Service account namespace
            <input
              value={namespace}
              onChange={(event) => {
                setNamespace(event.target.value);
                setSecret('');
                setAccount('');
              }}
              placeholder="observability"
              maxLength={63}
              className="sre-field mt-1 w-full"
            />
          </label>
          {ns && !namespaceValid && (
            <p className="text-xs text-critical">Enter a valid Kubernetes namespace.</p>
          )}
        </section>
        {namespaceValid && (
          <>
            <section className="min-w-0 space-y-2">
              <h3 className="font-medium">2. Find its stored token Secret</h3>
              <SetupCommand
                command={`${kubectl} get secrets --field-selector=type=kubernetes.io/service-account-token -o 'custom-columns=SECRET:.metadata.name,SERVICE_ACCOUNT:.metadata.annotations.kubernetes\\.io/service-account\\.name'`}
                copyLabel="Copy token Secret lookup command"
              />
              <p className="text-xs text-ink-muted">
                This lists names, not token values. Choose the Secret whose SERVICE_ACCOUNT matches
                your read-only account. You need permission to read that Secret; do not add Secret
                access to the integration account just to retrieve its credential.
              </p>
              <label className="block font-medium">
                Token Secret name
                <input
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                  placeholder="reader-token"
                  maxLength={253}
                  className="sre-field mt-1 w-full"
                />
              </label>
              {secretName && !validName(secretName) && (
                <p className="text-xs text-critical">Enter a valid Secret name.</p>
              )}
            </section>
            {validName(secretName) && (
              <section className="min-w-0 space-y-2">
                <h3 className="font-medium">3. Copy the outputs into the credential fields</h3>
                <p>
                  Paste this output into <strong>Service account token</strong>:
                </p>
                <SetupCommand
                  command={`${kubectl} get secret '${secretName}' -o jsonpath='{.data.token}' | base64 -d`}
                  copyLabel="Copy existing token command"
                />
                <p>
                  When pinning a CA, paste this output into <strong>CA certificate (PEM)</strong>:
                </p>
                <SetupCommand
                  command={`${kubectl} get secret '${secretName}' -o jsonpath='{.data.ca\\.crt}' | base64 -d`}
                  copyLabel="Copy existing CA command"
                />
                <p className="text-xs text-ink-muted">
                  Paste the decoded output, not the command or base64 text. The PEM starts with
                  -----BEGIN CERTIFICATE-----. It is a public CA certificate, not a private key.
                </p>
              </section>
            )}
            <details className="rounded border border-line p-3">
              <summary className="cursor-pointer font-medium">No token Secret listed?</summary>
              <div className="mt-3 min-w-0 space-y-3">
                <p className="text-xs text-ink-muted">
                  An existing service account may not have a stored token. You can request a
                  temporary token for that same account without recreating its RBAC.
                </p>
                <label className="block font-medium">
                  Existing service account name
                  <input
                    value={account}
                    onChange={(event) => setAccount(event.target.value)}
                    placeholder="reader"
                    maxLength={253}
                    className="sre-field mt-1 w-full"
                  />
                </label>
                {accountName && !validName(accountName) && (
                  <p className="text-xs text-critical">Enter a valid service account name.</p>
                )}
                {validName(accountName) && (
                  <SetupCommand
                    command={`${kubectl} create token '${accountName}' --duration=1h`}
                    copyLabel="Copy temporary token command"
                  />
                )}
                <p className="rounded border border-warning-line bg-warning-soft p-3 text-xs text-warning">
                  Temporary testing only. The server chooses the actual lifetime. SRE Platform
                  stores the pasted token but does not renew it; this connection stops
                  authenticating when it expires. For ongoing use, ask your administrator for a
                  managed credential and rotation process. Do not treat a temporary token as
                  permanent access.
                </p>
                <p className="text-xs text-ink-muted">
                  The namespace's root CA is available separately:
                </p>
                <SetupCommand
                  command={`${kubectl} get configmap kube-root-ca.crt -o jsonpath='{.data.ca\\.crt}'`}
                  copyLabel="Copy namespace CA command"
                />
              </div>
            </details>
            <p className="text-xs text-ink-muted">
              If the Secret has no CA or the API is behind a TLS proxy, ask your administrator for
              the CA that verifies that API endpoint. For Forbidden errors, request help from an
              authorized cluster administrator instead of broadening the integration's permissions.
            </p>
          </>
        )}
      </div>
    </details>
  );
}
