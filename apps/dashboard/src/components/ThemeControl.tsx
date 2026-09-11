import { useTheme, type ThemePreference } from '../theme';

const OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Keeps appearance choices in a native, keyboard-accessible icon selector. */
export function ThemeControl() {
  const { preference, setPreference } = useTheme();
  const label = OPTIONS.find((option) => option.value === preference)!.label;

  return (
    <span
      title={`Appearance: ${label}`}
      className="relative inline-grid size-9 shrink-0 place-items-center rounded-md text-ink-muted hover:bg-surface-subtle hover:text-ink focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none size-5"
      >
        {preference === 'system' ? (
          <>
            <rect x="3" y="4" width="18" height="13" rx="2" />
            <path d="M12 17v4M8 21h8" />
          </>
        ) : preference === 'light' ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
          </>
        ) : (
          <path d="M20.9 13.2A9 9 0 0 1 10.8 3.1a9 9 0 1 0 10.1 10.1Z" />
        )}
      </svg>
      <select
        aria-label="Appearance"
        value={preference}
        onChange={(event) => setPreference(event.target.value as ThemePreference)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      >
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}
