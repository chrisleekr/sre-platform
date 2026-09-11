import type { ReactNode } from 'react';
import { ThemeControl } from '../components/ThemeControl';
import { Link } from 'react-router-dom';

export function PublicShell({
  children,
  entry = false,
  productName = 'SRE Platform',
}: {
  children: ReactNode;
  entry?: boolean;
  productName?: string;
}) {
  return (
    <main className="relative min-h-dvh bg-canvas p-4 text-ink sm:p-8">
      <div className="mx-auto mb-6 flex max-w-6xl items-center justify-between">
        <Link to="/" className="font-display text-lg font-semibold tracking-tight">
          {productName}
        </Link>
        <ThemeControl />
      </div>
      <div className="mx-auto w-full max-w-6xl pt-2 sm:pt-6">
        <section
          className={
            entry
              ? 'min-w-0 [overflow-wrap:anywhere]'
              : 'min-w-0 w-full rounded-xl border border-line bg-surface p-5 [overflow-wrap:anywhere] sm:p-8'
          }
        >
          {children}
        </section>
      </div>
    </main>
  );
}

const progressWidth = {
  1: 'w-1/3',
  2: 'w-2/3',
  3: 'w-full',
} as const;

/** Compact progress for the single-page workspace setup journey. */
export function SetupProgress({
  step,
  onEditWorkspace,
  onEditSignIn,
}: {
  step: 1 | 2 | 3;
  onEditWorkspace?: () => void;
  onEditSignIn?: () => void;
}) {
  const steps = [
    { label: 'Workspace', edit: onEditWorkspace },
    { label: 'Company sign-in', edit: onEditSignIn },
    { label: 'Review and create', edit: undefined },
  ];
  return (
    <nav aria-label="Workspace setup progress" className="mb-8">
      <div className="mb-3 flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-info">
          Workspace setup · Step {step} of 3
        </p>
        {(onEditWorkspace || onEditSignIn) && (
          <p className="text-xs text-ink-muted">You can edit previous steps</p>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-subtle" aria-hidden="true">
        <div className={`h-full rounded-full bg-info ${progressWidth[step]}`} />
      </div>
      <ol className="mt-3 grid grid-cols-3 gap-2 text-xs sm:text-sm">
        {steps.map(({ label, edit }, index) => {
          const completed = index + 1 < step;
          const current = index + 1 === step;
          return (
            <li
              key={label}
              aria-current={current ? 'step' : undefined}
              className={current ? 'font-semibold text-ink' : 'text-ink-muted'}
            >
              {completed && edit ? (
                <button type="button" className="font-semibold text-info underline" onClick={edit}>
                  {label} · Edit
                </button>
              ) : (
                <span>{label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export const fieldClass =
  'mt-1 w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
export const primaryButton =
  'rounded-lg bg-strong px-4 py-2.5 text-sm font-semibold text-on-strong hover:bg-strong-hover disabled:cursor-not-allowed disabled:opacity-50';
export const secondaryButton =
  'rounded-lg border border-line-strong px-4 py-2.5 text-sm font-semibold hover:bg-surface-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';
