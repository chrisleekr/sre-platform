import { describe, expect, test } from 'vitest';
import { INBOUND_CONNECTORS, INBOUND_SURFACES } from '../catalog';
import { makeFakeInboundConnector } from '../fake';
import { InboundRegistry } from '../registry';
import { defaultInboundRegistry } from '../registry-default';
import { INBOUND_SURFACE_IDS } from '../types';

describe('InboundRegistry', () => {
  test('C6 register then get returns the connector', () => {
    const reg = new InboundRegistry();
    const fake = makeFakeInboundConnector('slack');
    reg.register(fake);
    expect(reg.get('slack')).toBe(fake);
    expect(reg.has('slack')).toBe(true);
    expect(reg.surfaces()).toContain('slack');
  });

  test('constructs from complete provider definitions', () => {
    const reg = new InboundRegistry(INBOUND_CONNECTORS);
    expect(reg.surfaces()).toEqual(INBOUND_SURFACES);
  });

  test('C6 get throws for an unregistered surface', () => {
    const reg = new InboundRegistry();
    expect(() => reg.get('telegram')).toThrow(/no inbound connector registered/);
  });

  test('C6 duplicate surfaces fail instead of replacing the registered adapter', () => {
    const reg = new InboundRegistry();
    const fake = makeFakeInboundConnector('slack');
    reg.register(fake);
    expect(() => reg.register(fake)).toThrow(/already registered/);
  });
});

describe('defaultInboundRegistry', () => {
  test('C7 defaultInboundRegistry contains the slack connector', () => {
    const reg = defaultInboundRegistry();
    expect(reg.has('slack')).toBe(true);
    expect(reg.get('slack').surface).toBe('slack');
  });

  test('contains every provider from the compile-time catalog', () => {
    expect(defaultInboundRegistry().surfaces()).toEqual(INBOUND_SURFACES);
    expect(INBOUND_SURFACES).toEqual(INBOUND_SURFACE_IDS);
  });
});
