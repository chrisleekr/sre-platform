import type { KeyboardEvent } from 'react';

export interface SegmentedTabItem {
  id: string;
  label: string;
  compactLabel?: string;
  count?: number;
}

export function SegmentedTabs({
  label,
  value,
  items,
  panelId,
  onChange,
}: {
  label: string;
  value: string;
  items: readonly SegmentedTabItem[];
  panelId: string;
  onChange: (id: string) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
      className="grid gap-1 rounded-lg border border-line bg-surface-subtle p-1"
    >
      {items.map((item) => {
        const active = value === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${panelId}-tab-${item.id}`}
            aria-label={item.label}
            aria-selected={active}
            aria-controls={panelId}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onChange(item.id);
                return;
              }
              let nextIndex: number | null = null;
              if (event.key === 'ArrowRight') nextIndex = (items.indexOf(item) + 1) % items.length;
              if (event.key === 'ArrowLeft')
                nextIndex = (items.indexOf(item) - 1 + items.length) % items.length;
              if (event.key === 'Home') nextIndex = 0;
              if (event.key === 'End') nextIndex = items.length - 1;
              if (nextIndex === null) return;
              event.preventDefault();
              const next = items[nextIndex];
              if (!next) return;
              document.getElementById(`${panelId}-tab-${next.id}`)?.focus();
            }}
            className={`sre-hit-target flex min-w-0 flex-col items-center justify-center gap-0 rounded-md px-1 py-1.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus sm:flex-row sm:gap-1.5 sm:px-2 sm:py-2 sm:text-sm ${
              active
                ? 'bg-strong text-on-strong shadow-sm'
                : 'text-ink-muted hover:bg-surface hover:text-ink'
            }`}
          >
            <span className="sm:hidden">{item.compactLabel ?? item.label}</span>
            <span className="hidden truncate sm:inline">{item.label}</span>
            {item.count !== undefined && (
              <span
                aria-hidden="true"
                className={`shrink-0 rounded px-1.5 py-0.5 font-instrument text-[0.68rem] tabular-nums ${
                  active ? 'bg-on-strong/10 text-on-strong' : 'bg-surface-strong text-ink-secondary'
                }`}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
