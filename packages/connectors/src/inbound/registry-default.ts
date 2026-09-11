import { INBOUND_CONNECTORS } from './catalog';
import { InboundRegistry } from './registry';

/**
 * Builds a registry containing every compiled inbound adapter.
 */
export function defaultInboundRegistry(): InboundRegistry {
  return new InboundRegistry(INBOUND_CONNECTORS);
}
