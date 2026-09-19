import { LoadingSkeleton, type LoadingSkeletonVariant } from './LoadingSkeleton';

type StatePanelProps = {
  state: 'loading' | 'empty' | 'error' | 'access';
  title: string;
  description?: string;
  onRetry?: () => void;
  announce?: boolean;
  skeleton?: LoadingSkeletonVariant;
};

const ROLE_BY_STATE = {
  empty: undefined,
  error: 'alert',
  access: 'alert',
} as const;

export function StatePanel({
  state,
  title,
  description,
  onRetry,
  announce = true,
  skeleton = 'list',
}: StatePanelProps) {
  if (state === 'loading') {
    return <LoadingSkeleton label={title} variant={skeleton} announce={announce} />;
  }

  const role = announce ? ROLE_BY_STATE[state] : undefined;

  return (
    <div
      data-page-state={state}
      role={role}
      className="flex min-h-36 flex-col justify-center rounded-xl border border-line bg-surface px-5 py-6"
    >
      <p className="text-sm font-semibold text-ink">{title}</p>
      {description && (
        <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-muted">{description}</p>
      )}
      {onRetry && (
        <button type="button" onClick={onRetry} className="sre-action mt-4 w-fit">
          Retry
        </button>
      )}
    </div>
  );
}

export function InlineAlert({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-critical-line bg-critical-soft px-4 py-3 text-sm text-critical"
    >
      <p>{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-critical-line bg-surface px-2.5 py-1.5 font-semibold hover:bg-critical-muted"
        >
          Retry
        </button>
      )}
    </div>
  );
}
