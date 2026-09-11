import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  clearSessionFailure,
  getSessionFailure,
  reportSessionFailure,
  reportTokenFailure,
  subscribeSessionFailure,
} from '../session-failure';

afterEach(() => clearSessionFailure());

describe('session failure store', () => {
  test('publishes the authentication failure and clear transitions', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionFailure(listener);

    reportSessionFailure('unauthorized');
    expect(getSessionFailure()).toBe('unauthorized');
    expect(listener).toHaveBeenCalledTimes(1);

    clearSessionFailure();
    expect(getSessionFailure()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  test('keeps the first failure until an explicit recovery clears it', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionFailure(listener);

    reportSessionFailure('token-unavailable');
    reportSessionFailure('unauthorized');
    expect(getSessionFailure()).toBe('token-unavailable');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test('promotes only permanent OIDC errors that require interactive recovery', () => {
    reportTokenFailure({ error: 'missing_refresh_token' });
    expect(getSessionFailure()).toBe('token-unavailable');

    clearSessionFailure();
    reportTokenFailure({ code: 'invalid_grant' });
    expect(getSessionFailure()).toBe('token-unavailable');

    clearSessionFailure();
    reportTokenFailure({ code: 'exchange_failed' });
    expect(getSessionFailure()).toBeNull();
  });
});
