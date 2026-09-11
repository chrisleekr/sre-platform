import { useEffect, useRef, useState } from 'react';
import type { Page } from './useKeysetPages';

/** Both forms of what is being paged, so the copy stays grammatical at a delta of one. */
export interface PagedNoun {
  one: string;
  many: string;
}

interface UsePaginationAnnouncerInput<T> {
  /** The accumulation from useKeysetPages. A new page here is the settle event worth announcing. */
  pages: Page<T>[];
  /** Null once the server reports no further page. */
  nextCursor: string | null | undefined;
  error: boolean;
  noun: PagedNoun;
  /** Scope identity. Changing it clears prior page accounting and live-region text. */
  resetKey?: string;
}

export interface UsePaginationAnnouncer {
  /** Text for the panel's polite live region; empty when there is nothing to say. */
  announcement: string;
  /** Announce an action the human just took, or pass '' to drop a result that is no longer true. */
  announce: (message: string) => void;
}

/**
 * keyset pagination is invisible to a screen reader. The Load button unmounts on click and the next
 * page is appended silently, so "loading", "three more arrived" and "that was the last page" are
 * indistinguishable. This owns the live-region text: the panel announces the ACTION on activation, this
 * announces the RESULT once the page lands.
 *
 * The delta comes from the page that just landed, never from a server total: a total answers "how many
 * exist", and the human who pressed Load more asked "what did that do".
 */
export function usePaginationAnnouncer<T>({
  pages,
  nextCursor,
  error,
  noun,
  resetKey,
}: UsePaginationAnnouncerInput<T>): UsePaginationAnnouncer {
  const [announcement, setAnnouncement] = useState('');
  // How many pages the human has already been told about. A ref rather than state because it records what
  // was said, and re-rendering on it would let a settled result re-announce itself.
  const announced = useRef(0);
  const announcedScope = useRef(resetKey);

  useEffect(() => {
    if (announcedScope.current !== resetKey) {
      announcedScope.current = resetKey;
      announced.current = 0;
      setAnnouncement('');
      return;
    }
    if (error) {
      // A failed page is reported by the panel's own role="alert" banner, so it is not repeated here.
      // Dropping the in-progress "Loading…" works only because `error` flipping true is itself a dep change
      // that re-runs this effect. It does NOT cover a message announced while `error` is ALREADY true: no dep
      // changes then, and the text would stand forever. So callers must not announce anything this effect
      // cannot later clear: DeploymentsPanel announces only on the advancing branch and fires a failed
      // same-cursor retry silently via refetch — that refetch settles where this effect cannot see it.
      setAnnouncement('');
      return;
    }
    if (pages.length === announced.current) return;
    // The first page is not pagination: no human asked for it, and the panel already blanks visibly.
    const isPagination = announced.current > 0;
    announced.current = pages.length;
    if (!isPagination) return;
    const delta = pages[pages.length - 1]?.rows.length ?? 0;
    // Two independent clauses. A page that landed empty has nothing to report beyond the terminal clause,
    // and "0 more loaded" would restate it in the least useful phrasing available. Composing the clauses
    // rather than special-casing keeps each one true on its own: an empty page that somehow did carry a
    // cursor falls silent instead of claiming the archive ended.
    const loaded = delta === 0 ? '' : `${delta} more ${delta === 1 ? noun.one : noun.many} loaded.`;
    const end = nextCursor ? '' : `No more ${noun.many} to load.`;
    setAnnouncement([loaded, end].filter(Boolean).join(' '));
  }, [error, pages, nextCursor, noun, resetKey]);

  return { announcement, announce: setAnnouncement };
}
