import { describe, expect, test } from 'vitest';
import { dashboardHeaders, loadDashboardRuntimeConfig, runtimeConfigScript } from '../server';

describe('dashboard runtime configuration', () => {
  test('maps container environment values to the browser contract', () => {
    expect(
      loadDashboardRuntimeConfig({
        DASHBOARD_API_BASE_URL: 'https://api.example.test',
        DASHBOARD_WS_BASE_URL: 'wss://api.example.test',
      }),
    ).toEqual({
      apiBaseUrl: 'https://api.example.test',
      wsBaseUrl: 'wss://api.example.test',
    });
  });

  test('escapes markup before generating executable browser configuration', () => {
    const script = runtimeConfigScript({
      apiBaseUrl: '</script><script>alert(1)</script>',
      wsBaseUrl: '',
    });

    expect(script).not.toContain('</script>');
    expect(script).toContain('\\u003c/script>');
  });

  test('prevents every dashboard response from being framed', () => {
    const headers = new Headers(dashboardHeaders('no-cache'));

    expect(headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(headers.get('x-frame-options')).toBe('DENY');
  });
});
