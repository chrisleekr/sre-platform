import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  action,
  headingLevel = 1,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  headingLevel?: 1 | 2;
}) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-line pb-4">
      <div className="min-w-0">
        <Heading className="sre-display text-xl text-ink sm:text-2xl">{title}</Heading>
        {description && (
          <p className="mt-1 max-w-4xl text-sm leading-6 text-ink-muted">{description}</p>
        )}
      </div>
      {action}
    </header>
  );
}
