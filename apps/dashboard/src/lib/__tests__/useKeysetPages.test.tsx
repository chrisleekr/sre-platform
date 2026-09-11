// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeysetPages, type UseKeysetPages } from '../useKeysetPages';

// Explicit so `cursor: undefined` in initialProps does not narrow to the literal `undefined` type, which
// would reject a real cursor on rerender.
type Props = {
  cursor: string | undefined;
  page: string[];
  loading: boolean;
  error: boolean;
  enabled?: boolean;
  resetKey?: string;
};

// The panels exercise useKeysetPages transitively, but the two rules the refactor OWNS —
// dedupe-by-cursor and settled-only append — are never provoked there: every panel mock advances the
// cursor on each click, so a single cursor is never re-settled. These pin them directly, so deleting the
// `.some()` guard or the loading/error gate turns the suite red instead of silently doubling pages.

describe('useKeysetPages', () => {
  test('appends one settled page, keyed by its cursor, and flattens in arrival order', () => {
    const { result, rerender } = renderHook<UseKeysetPages<string>, Props>(
      (props) => useKeysetPages<string>(props),
      {
        initialProps: { cursor: undefined, page: ['a'], loading: false, error: false },
      },
    );

    expect(result.current.pages).toEqual([{ cursor: undefined, rows: ['a'] }]);
    expect(result.current.rows).toEqual(['a']);

    rerender({ cursor: 'c1', page: ['b'], loading: false, error: false });
    rerender({ cursor: 'c2', page: ['c'], loading: false, error: false });

    expect(result.current.pages).toHaveLength(3);
    expect(result.current.rows).toEqual(['a', 'b', 'c']);
  });

  test('dedupes by cursor: a re-settle of the same cursor with a fresh array is not re-appended', () => {
    const { result, rerender } = renderHook<UseKeysetPages<string>, Props>(
      (props) => useKeysetPages<string>(props),
      {
        initialProps: { cursor: undefined, page: ['a', 'b'], loading: false, error: false },
      },
    );

    expect(result.current.pages).toHaveLength(1);

    // Same cursor, brand-new array identity — the append effect re-runs but the dedupe guard must hold.
    rerender({ cursor: undefined, page: ['a', 'b'], loading: false, error: false });

    expect(result.current.pages).toHaveLength(1);
    expect(result.current.rows).toEqual(['a', 'b']);
  });

  test('never appends a page that is still loading or errored; appends once it settles', () => {
    const { result, rerender } = renderHook<UseKeysetPages<string>, Props>(
      (props) => useKeysetPages<string>(props),
      {
        initialProps: { cursor: undefined, page: ['a'], loading: true, error: false },
      },
    );
    expect(result.current.pages).toHaveLength(0);

    rerender({ cursor: undefined, page: ['a'], loading: false, error: true });
    expect(result.current.pages).toHaveLength(0);

    rerender({ cursor: undefined, page: ['a'], loading: false, error: false });
    expect(result.current.pages).toEqual([{ cursor: undefined, rows: ['a'] }]);
  });

  test('enabled=false keeps a settled page out of the accumulation until enabled flips true', () => {
    const { result, rerender } = renderHook<UseKeysetPages<string>, Props>(
      (props) => useKeysetPages<string>(props),
      {
        initialProps: {
          cursor: undefined,
          page: ['a'],
          loading: false,
          error: false,
          enabled: false,
        },
      },
    );
    expect(result.current.pages).toHaveLength(0);

    rerender({ cursor: undefined, page: ['a'], loading: false, error: false, enabled: true });
    expect(result.current.pages).toEqual([{ cursor: undefined, rows: ['a'] }]);
  });

  test('clears prior pages when the surrounding filter scope changes', () => {
    const { result, rerender } = renderHook<UseKeysetPages<string>, Props>(
      (props) => useKeysetPages<string>(props),
      {
        initialProps: {
          cursor: undefined,
          page: ['old'],
          loading: false,
          error: false,
          resetKey: '24h',
        },
      },
    );
    expect(result.current.rows).toEqual(['old']);

    rerender({
      cursor: undefined,
      page: ['new'],
      loading: false,
      error: false,
      resetKey: '7d',
    });
    expect(result.current.rows).toEqual(['new']);
  });
});
