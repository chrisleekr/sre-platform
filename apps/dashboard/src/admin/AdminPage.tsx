import type { ReactNode } from 'react';
import { PageHeader } from '../components/PageHeader';
import { StatePanel } from '../components/PageState';

/** Gives every administrator section the same title, loading, and error treatment. */
export function AdminPage({
  title,
  description,
  loading,
  error,
  onRetry,
  children,
}: {
  title: string;
  description: string;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[1500px] space-y-5">
      <PageHeader title={title} description={description} />
      {loading ? (
        <StatePanel state="loading" title={`Loading ${title.toLowerCase()}…`} />
      ) : error ? (
        <StatePanel state="error" title={error} onRetry={onRetry} />
      ) : (
        children
      )}
    </div>
  );
}
