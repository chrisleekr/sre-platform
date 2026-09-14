export function EvidenceCitation({
  evidenceId,
  onSelect,
  context,
}: {
  evidenceId: string;
  onSelect: (id: string, context?: string) => void;
  context?: string;
}) {
  return (
    <a
      href={`#evidence-${evidenceId}`}
      onClick={(event) => {
        event.preventDefault();
        onSelect(evidenceId, context);
      }}
      className="inline-flex rounded bg-assessment-muted px-1.5 py-0.5 font-instrument text-xs font-semibold text-assessment hover:bg-assessment-muted"
      aria-label={`Open evidence ${evidenceId}`}
    >
      E{evidenceId.slice(0, 4)}…{evidenceId.slice(-4)}
    </a>
  );
}
