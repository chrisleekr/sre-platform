import { useState } from 'react';

export function SystemHookFields({
  baseUrl,
  receiver,
  name,
}: {
  baseUrl: string;
  receiver: string;
  name: string;
}) {
  const [copyStatus, setCopyStatus] = useState('');
  const fields = [
    ['URL', receiver],
    ['Name', name],
  ];
  const settings = [
    ['Description', 'Authenticated change and deployment evidence for incident diagnosis'],
    ['Push events', 'Enable. Select all branches; do not add a branch filter.'],
    ['Tag push events', 'Enable.'],
    ['Merge request events', 'Enable.'],
    ['Repository update events', 'Enable.'],
    [
      'Enable SSL verification',
      'Keep enabled. Fix certificate errors instead of disabling verification.',
    ],
    [
      'Custom headers / Custom webhook template',
      'Leave empty. SRE Platform requires the original GitLab event body.',
    ],
  ];
  return (
    <section
      aria-label="System hook form guide"
      className="space-y-4 rounded border border-line bg-surface-subtle p-3"
    >
      <div className="space-y-2 text-sm">
        <p className="font-semibold">Open the system-hook form</p>
        <p>
          Sign in as a GitLab instance administrator. Open{' '}
          <strong>Admin → System hooks → Add new webhook</strong>. If this connection already has a
          hook, edit that hook instead of adding a second one.
        </p>
        <a
          className="inline-block min-h-9 text-link underline"
          href={`${baseUrl.replace(/\/+$/, '')}/admin/hooks`}
          target="_blank"
          rel="noreferrer"
        >
          Open this GitLab instance's system hooks
        </a>
      </div>
      <div className="space-y-3">
        <p className="text-sm font-semibold">Use these values</p>
        <dl className="space-y-3 text-sm">
          {fields.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="font-medium">{label}</dt>
              <dd className="mt-1 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start">
                <code className="min-w-0 flex-1 break-all rounded bg-code p-2 text-xs text-code-ink">
                  {value || 'Not available. Complete receiver preparation in Events first.'}
                </code>
                <button
                  type="button"
                  disabled={!value}
                  className="min-h-9 shrink-0 rounded border border-line-strong px-3 py-1.5"
                  onClick={() => {
                    void Promise.resolve()
                      .then(() => navigator.clipboard.writeText(value!))
                      .then(() => setCopyStatus(`${label} copied.`))
                      .catch(() =>
                        setCopyStatus(
                          'Clipboard unavailable. Select and copy the displayed value.',
                        ),
                      );
                  }}
                >
                  Copy {label}
                </button>
              </dd>
            </div>
          ))}
        </dl>
        <p role="status" className="text-xs text-ink-muted">
          {copyStatus}
        </p>
        <p className="text-xs text-ink-muted">
          For Smee, URL is the generated channel address, not localhost. For public HTTPS delivery,
          it is the full generated API webhook address, not the dashboard or GitLab URL.
        </p>
      </div>
      <dl className="divide-y divide-line text-sm">
        {settings.map(([field, instruction]) => (
          <div
            key={field}
            className="grid gap-1 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-4"
          >
            <dt className="font-medium">{field}</dt>
            <dd className="text-ink-secondary">{instruction}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-2 rounded border border-warning-line bg-warning-soft p-3 text-sm">
        <p className="font-semibold">Secret token is not the signing token</p>
        <p>
          Do not paste the generated <code>whsec_…</code> signing token into GitLab's{' '}
          <strong>Secret token</strong> field. That field sends a legacy header; it does not
          configure HMAC signing. Leave it empty for signed delivery, or keep your existing legacy
          secret unchanged.
        </p>
        <p>
          The generated command below installs the signing token through GitLab's API and configures
          the URL and triggers. Run it once after saving this connection; you do not also need to
          add a hook manually.
        </p>
        <p>
          If you fill the form manually, choose <strong>Add system hook</strong> (or save the
          existing hook), using the exact name above. Then run the command to attach the signing
          token before testing. For an existing legacy-secret connection, use the original secret
          matching SRE Platform, not the read-only API token.
        </p>
      </div>
      <p className="text-sm text-ink-muted">
        Project, group, and user lifecycle events fire automatically; there is no project-only scope
        selector here. GitLab sends instance-wide events to this address. SRE Platform discards
        unrelated data after receiving it. CI/CD and release events are supplied by read-only
        polling, not additional system-hook checkboxes.
      </p>
      <a
        className="inline-block text-sm text-link underline"
        href="https://docs.gitlab.com/administration/system_hooks/"
        target="_blank"
        rel="noreferrer"
      >
        GitLab's system-hook setup reference
      </a>
    </section>
  );
}

export function SystemHookTroubleshooting() {
  return (
    <details className="rounded border border-line p-3 text-sm">
      <summary className="cursor-pointer font-medium">Delivery failed or still waiting?</summary>
      <dl className="mt-3 space-y-3">
        <div>
          <dt className="font-medium">Connection refused, timeout, or TLS error</dt>
          <dd>
            Check that GitLab can reach the receiver. For Smee, confirm the relay is connected and
            the hook uses the same channel. For HTTPS, check ingress routing and the certificate. Do
            not disable SSL verification to hide a certificate problem.
          </dd>
        </div>
        <div>
          <dt className="font-medium">401 or 403 from the receiver</dt>
          <dd>
            Check the signing token on both sides. A signing token pasted into Secret token will not
            work. If you rotated it, save the replacement in SRE Platform and update the hook using
            the command before retrying.
          </dd>
        </div>
        <div>
          <dt className="font-medium">404 from the receiver</dt>
          <dd>
            Check the complete generated webhook path, not just the hostname. Save and verify the
            connection first; unsaved receiver addresses do not accept events.
          </dd>
        </div>
        <div>
          <dt className="font-medium">
            GitLab test returned success, but no authenticated event appears
          </dt>
          <dd>
            A generic system-hook test uses mock data and may not identify a project in your
            configured group. An ignored event is not delivery proof. Inspect a real in-scope event
            in Recent events, then refresh the connection's authenticated delivery evidence.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Pipeline or deployment updates are missing</dt>
          <dd>
            Check Project polling coverage on the connection details for backlog, missing access,
            rate limits, or projects not checked yet. A successful system-hook delivery does not
            prove polling works.
          </dd>
        </div>
      </dl>
    </details>
  );
}
