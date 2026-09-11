import { useState } from 'react';
import { absoluteApiUrl, config } from '../config';

interface Props {
  providerId: string;
  enabled: boolean;
  typRequired: boolean;
  disabled?: boolean;
  onChange(enabled: boolean): void;
  onTypRequiredChange(typRequired: boolean): void;
}

/** Shows the opt-in control and exact provider callback for OIDC back-channel logout. */
export function BackchannelLogoutSetting({
  providerId,
  enabled,
  typRequired,
  disabled,
  onChange,
  onTypRequiredChange,
}: Props) {
  const [copyStatus, setCopyStatus] = useState('');
  const callback = absoluteApiUrl(
    `/auth/providers/${providerId}/backchannel-logout`,
    config.apiBaseUrl,
    window.location.origin,
  );
  async function copyCallback() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(callback);
      setCopyStatus('Copied');
    } catch {
      setCopyStatus('Select and copy the URL manually.');
    }
  }
  return (
    <div className="rounded-lg border border-line bg-surface-subtle p-4 md:col-span-2">
      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-1 size-4 accent-current"
        />
        <span>
          <span className="block font-semibold text-ink">Provider-initiated logout</span>
          <span className="mt-0.5 block leading-5 text-ink-muted">
            Enable this only when the directory supports OpenID Connect back-channel logout.
          </span>
        </span>
      </label>
      {enabled && (
        <div className="mt-3 border-t border-line pt-3">
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={typRequired}
              disabled={disabled}
              onChange={(event) => onTypRequiredChange(event.target.checked)}
              className="mt-1 size-4 accent-current"
            />
            <span>
              <span className="block font-semibold text-ink">Require logout+jwt token type</span>
              <span className="mt-0.5 block leading-5 text-ink-muted">
                Turn this on only when the directory always sends the final-spec token type.
              </span>
            </span>
          </label>
          <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Back-channel logout URL
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 break-all rounded-md bg-canvas px-3 py-2 text-xs text-ink">
              {callback}
            </code>
            <button
              type="button"
              onClick={() => void copyCallback()}
              className="rounded-md border border-line-strong bg-surface px-3 py-2 text-xs font-semibold"
            >
              Copy URL
            </button>
          </div>
          {copyStatus && <p className="mt-1 text-xs text-ink-muted">{copyStatus}</p>}
        </div>
      )}
    </div>
  );
}
