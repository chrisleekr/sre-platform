import type { ReactNode } from 'react';
import { PublicShell } from './shared';

/** Keeps product context beside the entry form without adding a navigation step. */
export function EntryLayout({
  children,
  productName,
  description,
}: {
  children: ReactNode;
  productName?: string;
  description?: string;
}) {
  return (
    <PublicShell entry productName={productName}>
      <div className="grid items-start gap-8 lg:grid-cols-[1.1fr_1fr] lg:gap-16 lg:py-12">
        <header className="min-w-0 lg:py-8">
          <p className="font-display text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Your AI SRE.
            <br />
            <span className="text-accent">Part of your team.</span>
          </p>
          <p className="mt-5 max-w-lg text-base leading-relaxed text-ink-muted sm:text-lg">
            {description ??
              'Built to work alongside you like a senior SRE: investigate problems, connect evidence across your systems, and help determine what to do next.'}
          </p>
        </header>
        <div className="min-w-0 rounded-xl border border-line bg-surface p-5 sm:p-8">
          {children}
        </div>
      </div>
    </PublicShell>
  );
}
