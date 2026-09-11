import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { PublicRateLimiter } from './contracts';

const TAKE_WINDOW = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
if current <= tonumber(ARGV[1]) then return 1 end
return 0
`;

/** Creates a replica-safe fixed-window limiter backed by one atomic Valkey script. */
export function makePublicRateLimiter(redis: Redis): PublicRateLimiter {
  return {
    async allow(scope, subject, limit, windowMs) {
      const digest = createHash('sha256').update(subject).digest('hex');
      const key = `public-rate:${scope}:${digest}`;
      return (await redis.eval(TAKE_WINDOW, 1, key, limit, windowMs)) === 1;
    },
  };
}

/** Resolves a client address from a socket peer and an explicitly trusted forwarding depth. */
export function forwardedSourceAddress(
  direct: string | undefined,
  forwardedHeader: string | undefined,
  trustedProxyHops: number,
): string {
  if (!direct) throw new Error('request source address is unavailable');
  if (trustedProxyHops === 0) return direct;
  const forwarded = forwardedHeader
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!forwarded || forwarded.length < trustedProxyHops) return direct;
  return forwarded[forwarded.length - trustedProxyHops] ?? direct;
}
