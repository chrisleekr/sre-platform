import { describe, it, expect } from 'vitest';

import {
  connectorCredentialKey,
  surfaceBotTokenKey,
  surfaceSigningSecretKey,
  surfaceWebhookSecretKey,
} from '../secret-keys';
import * as secretKeys from '../secret-keys';

// Locks the exact SecretStore key strings so the centralized builders stay
// byte-identical to today's inline interpolations. A drift here makes already
// stored secrets unreadable.
describe('secret-keys builders', () => {
  it('connectorCredentialKey namespaces under connector:', () => {
    expect(connectorCredentialKey('gitlab')).toBe('connector:gitlab');
    expect(connectorCredentialKey('datadog')).toBe('connector:datadog');
  });

  it('surfaceBotTokenKey namespaces per surface', () => {
    expect(surfaceBotTokenKey('slack')).toBe('slack:bot_token');
  });

  it('surfaceSigningSecretKey namespaces per surface', () => {
    expect(surfaceSigningSecretKey('slack')).toBe('slack:signing_secret');
  });

  it('surfaceWebhookSecretKey namespaces per surface', () => {
    expect(surfaceWebhookSecretKey('slack')).toBe('slack:webhook_secret');
  });

  it('surfaceAppTokenKey namespaces the Socket Mode app token per surface', () => {
    const surfaceAppTokenKey = (
      secretKeys as unknown as { surfaceAppTokenKey?: (surface: string) => string }
    ).surfaceAppTokenKey;

    expect(surfaceAppTokenKey).toBeTypeOf('function');
    expect(surfaceAppTokenKey?.('slack')).toBe('slack:app_token');
  });
});
