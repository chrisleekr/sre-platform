import { useState } from 'react';

/** Requires the workspace address before a destructive authentication change. */
export function WorkspaceMutationConfirmation({
  title,
  slug,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  slug: string;
  busy: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const [confirmation, setConfirmation] = useState('');
  return (
    <section
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="workspace-mutation-title"
      className="rounded-xl border border-critical-line bg-critical-soft p-5"
    >
      <h2 id="workspace-mutation-title" className="font-semibold text-critical">
        {title}
      </h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && confirmation === slug) onConfirm();
        }}
      >
        <label className="mt-4 block text-sm font-medium">
          Type {slug} to confirm
          <input
            autoFocus
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            className="mt-2 block w-full max-w-lg rounded-lg border border-critical-line bg-surface px-3 py-2.5 text-ink"
          />
        </label>
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-lg border border-line-strong bg-surface px-4 py-2.5 text-sm font-semibold"
          >
            Cancel
          </button>
          <button
            disabled={busy || confirmation !== slug}
            className="rounded-lg bg-strong px-4 py-2.5 text-sm font-semibold text-on-strong disabled:opacity-50"
          >
            Confirm change
          </button>
        </div>
      </form>
    </section>
  );
}
