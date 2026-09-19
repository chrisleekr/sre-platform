export function DataSourceNameField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="text-sm font-medium">
      Data source name
      <input
        required
        maxLength={80}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="sre-field mt-1 min-w-0 w-full"
      />
      <span className="mt-1 block text-xs font-normal text-ink-muted">
        A stable human-readable name, for example Production or EU observability.
      </span>
    </label>
  );
}
