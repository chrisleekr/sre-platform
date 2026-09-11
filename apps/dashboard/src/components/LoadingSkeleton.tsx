import type { ReactNode } from 'react';

export type LoadingSkeletonVariant =
  'cards' | 'detail' | 'list' | 'report' | 'settings' | 'table' | 'topology';

export function SkeletonBlock({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`sre-skeleton block rounded ${className}`} />;
}

function MetricStrip({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="rounded-lg border border-line bg-surface p-4">
          <SkeletonBlock className="h-3 w-24 max-w-full" />
          <SkeletonBlock className="mt-3 h-8 w-16" />
          <SkeletonBlock className="mt-3 h-3 w-36 max-w-full" />
        </div>
      ))}
    </div>
  );
}

function Row({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`rounded-lg border border-line bg-surface ${compact ? 'p-3' : 'p-4'}`}>
      <div className="flex items-center gap-2">
        <SkeletonBlock className="h-5 w-14 rounded-full" />
        <SkeletonBlock className="h-4 w-32 max-w-[45%]" />
        <SkeletonBlock className="ml-auto h-3 w-16" />
      </div>
      <SkeletonBlock className="mt-3 h-4 w-3/4" />
      <SkeletonBlock className="mt-2 h-3 w-2/5" />
      {!compact && <SkeletonBlock className="mt-4 h-3 w-11/12" />}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface-subtle p-1 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <SkeletonBlock key={index} className="h-9" />
        ))}
      </div>
      <Row />
      <Row />
      <Row />
    </div>
  );
}

function CardsSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="min-h-36 rounded-lg border border-line bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <SkeletonBlock className="h-4 w-28" />
            <SkeletonBlock className="h-5 w-20 rounded-full" />
          </div>
          <SkeletonBlock className="mt-4 h-3 w-full" />
          <SkeletonBlock className="mt-2 h-3 w-4/5" />
          <SkeletonBlock className="mt-6 h-8 w-24" />
        </div>
      ))}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-4">
      <MetricStrip />
      <div className="grid gap-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index}>
            <SkeletonBlock className="h-3 w-20" />
            <SkeletonBlock className="mt-2 h-10 w-full" />
          </div>
        ))}
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface p-4">
        <SkeletonBlock className="h-4 w-40" />
        <div className="mt-4 space-y-3">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="grid grid-cols-[minmax(8rem,1.4fr)_1fr_5rem] gap-4">
              <SkeletonBlock className="h-4" />
              <SkeletonBlock className="h-4" />
              <SkeletonBlock className="h-4" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div className="space-y-4">
      <MetricStrip />
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="rounded-lg border border-line bg-surface p-4">
          <SkeletonBlock className="h-4 w-40" />
          <SkeletonBlock className="mt-2 h-3 w-64 max-w-full" />
          <div className="mt-5 space-y-3">
            {Array.from({ length: index === 0 ? 3 : 5 }, (_row, rowIndex) => (
              <div key={rowIndex} className="grid grid-cols-[minmax(8rem,1.4fr)_1fr_5rem] gap-4">
                <SkeletonBlock className="h-4" />
                <SkeletonBlock className="h-4" />
                <SkeletonBlock className="h-4" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-line bg-surface p-5">
        <div className="flex flex-wrap gap-2">
          <SkeletonBlock className="h-6 w-14 rounded-full" />
          <SkeletonBlock className="h-6 w-24 rounded-full" />
          <SkeletonBlock className="h-6 w-28 rounded-full" />
        </div>
        <SkeletonBlock className="mt-5 h-7 w-3/5" />
        <SkeletonBlock className="mt-3 h-4 w-2/5" />
      </div>
      <MetricStrip />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,1fr)]">
        <div className="space-y-3 rounded-lg border border-line bg-surface p-4">
          <SkeletonBlock className="h-4 w-36" />
          <Row compact />
          <Row compact />
          <Row compact />
        </div>
        <div className="rounded-lg border border-line bg-surface p-4">
          <SkeletonBlock className="h-4 w-32" />
          <SkeletonBlock className="mt-4 h-24 w-full" />
          <SkeletonBlock className="mt-3 h-10 w-full" />
        </div>
      </div>
    </div>
  );
}

function TopologySkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="rounded-lg border border-line bg-surface p-3">
            <SkeletonBlock className="h-3 w-20 max-w-full" />
            <SkeletonBlock className="mt-3 h-7 w-10" />
          </div>
        ))}
      </div>
      <div className="flex gap-3 rounded-lg border border-line bg-surface p-3">
        <SkeletonBlock className="h-10 w-24" />
        <SkeletonBlock className="h-10 flex-1" />
        <SkeletonBlock className="hidden h-10 w-40 sm:block" />
      </div>
      <div className="relative min-h-80 overflow-hidden rounded-lg border border-line bg-surface p-6">
        <SkeletonBlock className="absolute left-[12%] top-[18%] size-16 rounded-full" />
        <SkeletonBlock className="absolute left-[43%] top-[38%] size-20 rounded-full" />
        <SkeletonBlock className="absolute right-[12%] top-[20%] size-14 rounded-full" />
        <SkeletonBlock className="absolute bottom-[16%] left-[24%] size-14 rounded-full" />
        <SkeletonBlock className="absolute bottom-[12%] right-[24%] size-16 rounded-full" />
      </div>
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="rounded-lg border border-line bg-surface p-4">
          <SkeletonBlock className="h-5 w-48 max-w-full" />
          <SkeletonBlock className="mt-2 h-3 w-3/5" />
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {Array.from({ length: index === 0 ? 4 : 2 }, (_field, fieldIndex) => (
              <div key={fieldIndex}>
                <SkeletonBlock className="h-3 w-24" />
                <SkeletonBlock className="mt-2 h-10 w-full" />
              </div>
            ))}
          </div>
          <SkeletonBlock className="mt-5 h-9 w-32" />
        </div>
      ))}
    </div>
  );
}

const VARIANTS: Record<LoadingSkeletonVariant, () => ReactNode> = {
  cards: CardsSkeleton,
  detail: DetailSkeleton,
  list: ListSkeleton,
  report: ReportSkeleton,
  settings: SettingsSkeleton,
  table: TableSkeleton,
  topology: TopologySkeleton,
};

export function LoadingSkeleton({
  label,
  variant = 'list',
  announce = true,
  className = '',
}: {
  label: string;
  variant?: LoadingSkeletonVariant;
  announce?: boolean;
  className?: string;
}) {
  const Skeleton = VARIANTS[variant];
  return (
    <div
      data-page-state="loading"
      data-skeleton-variant={variant}
      role={announce ? 'status' : undefined}
      aria-live={announce ? 'polite' : undefined}
      aria-busy="true"
      className={`min-h-36 ${className}`}
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">
        <Skeleton />
      </div>
    </div>
  );
}

export function SkeletonRows({
  label,
  rows = 2,
  compact = true,
  announce = true,
}: {
  label: string;
  rows?: number;
  compact?: boolean;
  announce?: boolean;
}) {
  return (
    <div
      role={announce ? 'status' : undefined}
      aria-live={announce ? 'polite' : undefined}
      aria-busy="true"
      className="space-y-2"
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="space-y-2">
        {Array.from({ length: rows }, (_, index) => (
          <Row key={index} compact={compact} />
        ))}
      </div>
    </div>
  );
}

export function InlineLoadingSkeleton({
  label,
  className = 'h-4 w-28',
}: {
  label: string;
  className?: string;
}) {
  return (
    <span role="status" aria-live="polite" aria-busy="true" className="inline-block align-middle">
      <span className="sr-only">{label}</span>
      <SkeletonBlock className={className} />
    </span>
  );
}

export function ApplicationLoadingSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex h-dvh min-w-0 overflow-hidden bg-canvas"
    >
      <span className="sr-only">Restoring your session…</span>
      <aside
        aria-hidden="true"
        className="hidden w-64 shrink-0 border-r border-line bg-surface p-5 lg:block"
      >
        <div className="flex items-center gap-3 border-b border-line pb-5">
          <SkeletonBlock className="size-9" />
          <div className="flex-1">
            <SkeletonBlock className="h-4 w-28" />
            <SkeletonBlock className="mt-2 h-3 w-20" />
          </div>
        </div>
        <div className="mt-6 space-y-5">
          {Array.from({ length: 3 }, (_, group) => (
            <div key={group} className="space-y-2">
              <SkeletonBlock className="h-2.5 w-16" />
              <SkeletonBlock className="h-9 w-full" />
              <SkeletonBlock className="h-9 w-4/5" />
            </div>
          ))}
        </div>
      </aside>
      <div aria-hidden="true" className="min-w-0 flex-1">
        <div className="flex h-14 items-center gap-3 border-b border-line bg-surface px-4 sm:px-5">
          <SkeletonBlock className="size-8 lg:hidden" />
          <SkeletonBlock className="h-3 w-28" />
          <SkeletonBlock className="ml-auto h-4 w-36" />
        </div>
        <main className="p-3 sm:p-5 xl:p-6">
          <SkeletonBlock className="h-7 w-56 max-w-3/4" />
          <SkeletonBlock className="mt-3 h-4 w-[34rem] max-w-full" />
          <div className="mt-8">
            <MetricStrip />
          </div>
          <div className="mt-6 grid gap-6 xl:grid-cols-2">
            <SkeletonRows label="" rows={3} announce={false} />
            <SkeletonRows label="" rows={3} announce={false} />
          </div>
        </main>
      </div>
    </div>
  );
}
