import { primaryButton } from './shared';

/** Makes a saved sign-in attempt visible and retryable without repeating registration. */
export function SignInStartNotice({
  error,
  pending,
  onRetry,
}: {
  error?: string;
  pending: boolean;
  onRetry?: () => void;
}) {
  return (
    <div className="my-5 space-y-3 rounded-lg border border-line p-4 text-sm">
      <p role={error ? 'alert' : 'status'} className={error ? 'text-critical' : 'text-ink-muted'}>
        {error ??
          (pending
            ? 'Opening your sign-in method…'
            : 'Your workspace details are saved. Continue sign-in to finish setup.')}
      </p>
      {onRetry && (
        <button type="button" className={primaryButton} disabled={pending} onClick={onRetry}>
          {error ? 'Retry this sign-in' : pending ? 'Opening sign-in…' : 'Continue saved sign-in'}
        </button>
      )}
    </div>
  );
}
