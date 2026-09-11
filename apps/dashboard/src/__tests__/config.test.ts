import { describe, expect, test } from 'vitest';
import { absoluteApiUrl, derivePublicConfigUrl, deriveWsBase, resolveAppConfig } from '../config';

describe('absoluteApiUrl', () => {
  test('builds exact same-origin and split-origin API callback URLs', () => {
    const path = '/auth/providers/provider-1/backchannel-logout';
    expect(absoluteApiUrl(path, '', 'https://dashboard.example.test')).toBe(
      'https://dashboard.example.test/auth/providers/provider-1/backchannel-logout',
    );
    expect(
      absoluteApiUrl(path, 'https://api.example.test/base/', 'https://dashboard.example.test'),
    ).toBe('https://api.example.test/base/auth/providers/provider-1/backchannel-logout');
  });
});

describe('deriveWsBase', () => {
  test('uses the split-origin API host for local development', () => {
    expect(deriveWsBase('http://localhost:43000', 'http://localhost:45173')).toBe(
      'ws://localhost:43000',
    );
  });

  test('uses a secure WebSocket and preserves an API path', () => {
    expect(deriveWsBase('https://sre.example.test/api')).toBe('wss://sre.example.test/api');
  });

  test('falls back to the page origin for a same-origin deployment', () => {
    expect(deriveWsBase('', 'https://sre.example.test')).toBe('wss://sre.example.test');
  });
});

describe('derivePublicConfigUrl', () => {
  test('uses a relative URL for same-origin deployments', () => {
    expect(derivePublicConfigUrl('')).toBe('/public-config');
  });

  test('uses the configured API origin and preserves its path', () => {
    expect(derivePublicConfigUrl('https://api.example.test/platform/')).toBe(
      'https://api.example.test/platform/public-config',
    );
  });
});

describe('resolveAppConfig', () => {
  test('prefers container runtime configuration over build-time values', () => {
    expect(
      resolveAppConfig(
        {
          apiBaseUrl: 'https://api.example.test',
          wsBaseUrl: '',
        },
        {
          VITE_AUTH0_DOMAIN: 'build.example.test',
          VITE_AUTH0_CLIENT_ID: 'build-client',
          VITE_API_BASE_URL: 'http://localhost:43000',
        },
      ),
    ).toEqual({
      apiBaseUrl: 'https://api.example.test',
      publicConfigUrl: 'https://api.example.test/public-config',
      wsBaseUrl: 'wss://api.example.test',
    });
  });

  test('keeps Vite configuration for the local development server', () => {
    expect(resolveAppConfig({}, { VITE_API_BASE_URL: 'http://localhost:43000' })).toMatchObject({
      apiBaseUrl: 'http://localhost:43000',
      publicConfigUrl: 'http://localhost:43000/public-config',
      wsBaseUrl: 'ws://localhost:43000',
    });
  });

  test('ignores obsolete provider-specific build configuration', () => {
    expect(resolveAppConfig({}, { VITE_AUTH0_DOMAIN: 'obsolete.invalid' })).toEqual({
      apiBaseUrl: '',
      publicConfigUrl: '/public-config',
      wsBaseUrl: '',
    });
  });
});
