import { useContext, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { SetupDialogSlots } from './SetupDialogSlots';

export function SetupProgress({ steps, current }: { steps: readonly string[]; current: number }) {
  const slots = useContext(SetupDialogSlots);
  const body = slots?.body;
  const previousStep = useRef(current);
  useLayoutEffect(() => {
    if (!body) return;
    body.scrollTop = 0;
    if (previousStep.current !== current) body.focus({ preventScroll: true });
    previousStep.current = current;
  }, [body, current]);
  const columns =
    steps.length === 5
      ? 'sm:grid-cols-5'
      : steps.length === 3
        ? 'sm:grid-cols-3'
        : 'sm:grid-cols-4';
  const progress = (
    <nav aria-label="Setup steps">
      <p className="mb-2 text-xs font-medium text-ink-secondary">
        Step {current} of {steps.length} · {steps[current - 1]}
      </p>
      <ol
        aria-label="Setup progress"
        className={`hidden gap-2 text-xs text-ink-muted sm:grid ${columns}`}
      >
        {steps.map((name, index) => {
          const position = index + 1;
          const active = position === current;
          const complete = position < current;
          return (
            <li
              key={name}
              aria-current={active ? 'step' : undefined}
              className={`flex min-w-0 items-center gap-1.5 ${active ? 'font-semibold text-ink' : ''}`}
            >
              <span
                aria-hidden="true"
                className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                  active
                    ? 'border-line-strong bg-strong text-on-strong'
                    : complete
                      ? 'border-line-strong bg-surface-strong text-ink-secondary'
                      : 'border-line-strong bg-surface'
                }`}
              >
                {position}
              </span>
              <span className="min-w-0 break-words">{name}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
  return slots ? (slots.navigation ? createPortal(progress, slots.navigation) : null) : progress;
}
