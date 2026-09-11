import { useState } from 'react';

export function SetupCommand({
  command,
  copyLabel = 'Copy command',
}: {
  command: string;
  copyLabel?: string;
}) {
  const [copyResult, setCopyResult] = useState<{ command: string; state: 'copied' | 'failed' }>();
  const copyState = copyResult?.command === command ? copyResult.state : 'idle';
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      setCopyResult({ command, state: 'copied' });
    } catch {
      setCopyResult({ command, state: 'failed' });
    }
  };
  return (
    <div className="min-w-0">
      <div className="min-w-0 overflow-hidden rounded-lg border border-line bg-code">
        <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-subtle px-3 py-1">
          <span className="text-xs font-medium text-ink-muted">Command</span>
          <button
            type="button"
            aria-label={copyLabel}
            onClick={() => void copy()}
            className="min-h-9 shrink-0 rounded px-3 py-1 text-xs font-medium text-ink hover:bg-surface-strong focus-visible:outline-2 focus-visible:outline-focus"
          >
            {copyState === 'copied' ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre
          tabIndex={0}
          aria-label={copyLabel.replace(/^Copy /, '')}
          className="max-h-60 min-w-0 overflow-auto whitespace-pre p-4 font-instrument text-xs leading-6 text-code-ink focus-visible:outline-2 focus-visible:outline-focus"
        >
          {command}
        </pre>
      </div>
      <p role="status" className="mt-1 text-xs text-ink-muted">
        {copyState === 'copied'
          ? 'Copied to clipboard.'
          : copyState === 'failed'
            ? 'Clipboard unavailable. Select and copy the text above.'
            : ''}
      </p>
    </div>
  );
}
