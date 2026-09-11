import { slackInboundConnector } from './slack';
import { INBOUND_SURFACE_IDS, type IInboundConnector, type InboundSurface } from './types';

/** Compile-time catalog of inbound surface adapters included in this deployment. */
export const INBOUND_CONNECTORS = [
  slackInboundConnector,
] as const satisfies readonly IInboundConnector<InboundSurface>[];
// The catalog and surface union move together, so a declared provider cannot be silently unwired.

const surfaces = new Set(INBOUND_CONNECTORS.map((connector) => connector.surface));
if (
  surfaces.size !== INBOUND_SURFACE_IDS.length ||
  INBOUND_SURFACE_IDS.some((surface) => !surfaces.has(surface))
) {
  throw new Error('inbound connector catalog must define each surface exactly once');
}

export const INBOUND_SURFACES: readonly InboundSurface[] = INBOUND_SURFACE_IDS;
