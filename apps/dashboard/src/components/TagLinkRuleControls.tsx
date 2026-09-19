import { useState } from 'react';
import { requestErrorMessage } from '../lib/request-error';

export interface TagLinkRule {
  prefix: string;
  urlTemplate: string;
}

/** Tenant tag-link configuration for references such as bug:1234. */
export function TagLinkRuleControls(props: {
  rules: readonly TagLinkRule[];
  onSave: (rule: TagLinkRule) => Promise<void>;
  onRemove: (prefix: string) => Promise<void>;
}) {
  const [prefix, setPrefix] = useState('');
  const [urlTemplate, setUrlTemplate] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section
      aria-label="Tag link settings"
      className="rounded-xl border border-line bg-surface p-4"
    >
      <h2 className="font-medium">Tag links</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Turn tenant tags such as bug:1234 into safe links. The URL must be HTTPS and contain{' '}
        <code>{'{value}'}</code>.
      </p>
      <ul className="mt-3 space-y-2 text-sm">
        {props.rules.map((rule) => (
          <li key={rule.prefix} className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate">
              <strong>{rule.prefix}:</strong> {rule.urlTemplate}
            </span>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setPending(true);
                setError(null);
                void props
                  .onRemove(rule.prefix)
                  .catch((cause) =>
                    setError(requestErrorMessage(cause, 'Tag link could not be removed.')),
                  )
                  .finally(() => setPending(false));
              }}
              className="sre-action sre-hit-target shrink-0"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 grid gap-2 sm:grid-cols-[10rem_1fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          if (!prefix.trim() || !urlTemplate.trim()) return;
          setPending(true);
          setError(null);
          void props
            .onSave({ prefix: prefix.trim(), urlTemplate: urlTemplate.trim() })
            .then(() => {
              setPrefix('');
              setUrlTemplate('');
            })
            .catch((cause) =>
              setError(
                requestErrorMessage(
                  cause,
                  'Tag link could not be saved. Review the prefix and HTTPS URL template, then retry.',
                ),
              ),
            )
            .finally(() => setPending(false));
        }}
      >
        <label className="text-sm">
          Prefix
          <input
            value={prefix}
            onChange={(event) => setPrefix(event.target.value)}
            placeholder="bug"
            className="sre-field mt-1 min-h-10 w-full"
          />
        </label>
        <label className="text-sm">
          HTTPS URL template
          <input
            value={urlTemplate}
            onChange={(event) => setUrlTemplate(event.target.value)}
            placeholder="https://tracker.example/issues/{value}"
            className="sre-field mt-1 min-h-10 w-full"
          />
        </label>
        <button
          type="submit"
          disabled={pending || !prefix.trim() || !urlTemplate.trim()}
          className="sre-action sre-hit-target self-end"
        >
          Save link
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-critical">
          {error}
        </p>
      )}
    </section>
  );
}
