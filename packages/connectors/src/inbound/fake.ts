import type { IInboundConnector } from './types';

/**
 * Creates a deterministic inbound adapter for registry and ingestion tests.
 *
 * @param surface - Surface identifier exposed by the fake adapter.
 * @param evaluateImpl - Optional event evaluator used by the test.
 */
export function makeFakeInboundConnector(
  surface: string,
  evaluateImpl?: IInboundConnector['evaluate'],
): IInboundConnector {
  return { surface, evaluate: evaluateImpl ?? (() => null) };
}
