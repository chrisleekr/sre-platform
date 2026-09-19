export function DeliveryPreparationStatus({
  busy,
  error,
  retry,
}: {
  busy: boolean;
  error: string;
  retry: () => void;
}) {
  if (busy)
    return (
      <p role="status" className="mb-3 text-sm text-ink-muted">
        Preparing your webhook address…
      </p>
    );
  if (!error) return null;
  return (
    <div className="mb-3 text-sm text-warning">
      <p role="alert">{error}</p>
      <button type="button" onClick={retry} className="sre-action mt-2">
        Retry webhook preparation
      </button>
    </div>
  );
}
