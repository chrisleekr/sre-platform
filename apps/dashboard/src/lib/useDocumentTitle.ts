import { useEffect } from 'react';

const PRODUCT_TITLE = 'SRE Platform';

export function formatDocumentTitle(page: string | null | undefined): string {
  return page ? `${page} · ${PRODUCT_TITLE}` : PRODUCT_TITLE;
}

/** Keep browser history and tabs identifiable when responders have several incidents open. */
export function useDocumentTitle(page: string | null | undefined): void {
  useEffect(() => {
    const previous = document.title;
    const next = formatDocumentTitle(page);
    document.title = next;
    return () => {
      if (document.title === next) document.title = previous;
    };
  }, [page]);
}
