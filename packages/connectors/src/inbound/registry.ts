import type { IInboundConnector } from './types';

/** Stores one stateless inbound connector instance for each compiled surface. */
export class InboundRegistry {
  private readonly bySurface = new Map<string, IInboundConnector>();

  constructor(connectors: readonly IInboundConnector[] = []) {
    for (const connector of connectors) this.register(connector);
  }

  register(connector: IInboundConnector): void {
    if (this.bySurface.has(connector.surface)) {
      throw new Error(`inbound connector already registered for surface: ${connector.surface}`);
    }
    this.bySurface.set(connector.surface, connector);
  }

  has(surface: string): boolean {
    return this.bySurface.has(surface);
  }

  surfaces(): string[] {
    return [...this.bySurface.keys()];
  }

  get(surface: string): IInboundConnector {
    const connector = this.bySurface.get(surface);
    if (!connector) throw new Error(`no inbound connector registered for surface: ${surface}`);
    return connector;
  }
}
