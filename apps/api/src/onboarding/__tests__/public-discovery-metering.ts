import type { Context } from 'hono';
import type { PublicRateLimiter } from '../contracts';

/**
 * Metering dependencies that keep the public discovery routes open. Those routes fail closed when
 * no limiter is configured, so a suite that is not testing the meter still has to supply one.
 */
export const permissivePublicMetering: {
  limiter: PublicRateLimiter;
  sourceAddress: (c: Context) => string;
} = {
  limiter: { allow: async () => true },
  sourceAddress: () => '203.0.113.1',
};
