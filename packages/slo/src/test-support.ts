// Test doubles for the read model. Deliberately NOT reachable from the package entrypoint: a fake SLI
// reader answers with a number that no query produced, and a reliability figure with no query behind
// it is the one thing this subsystem must never show. Kept importable only as `@sre/slo/test-support`,
// mirroring the database workspace, so production code cannot reach it by accident.

import type { SliQuery, SliReader } from './sli-reader';

/**
 * Builds a test reader that answers each query from a caller-supplied function.
 *
 * @param answer - Maps one query, typically by its window, to a bad-event ratio.
 */
export function makeFakeSliReader(answer: (query: SliQuery) => number): SliReader {
  return { querySliRatio: async (query) => answer(query) };
}
