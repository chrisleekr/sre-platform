export const SLACK_CLASSIFY_PENDING = 'pending';
export const SLACK_CLASSIFY_SUPPRESSED = 'suppressed';
export const SLACK_CLASSIFY_TERMINAL = 'terminal';

export type SlackClassifyReservationState =
  typeof SLACK_CLASSIFY_PENDING | typeof SLACK_CLASSIFY_SUPPRESSED | typeof SLACK_CLASSIFY_TERMINAL;

const STATE_RANK: Record<SlackClassifyReservationState, number> = {
  [SLACK_CLASSIFY_PENDING]: 1,
  [SLACK_CLASSIFY_TERMINAL]: 2,
  [SLACK_CLASSIFY_SUPPRESSED]: 3,
};

const WRITE_RESERVATION_LUA = `
local currentVersionValue = redis.call('get', KEYS[2])
local currentVersion = tonumber(currentVersionValue)
local currentState = redis.call('get', KEYS[1])
local nextVersion = tonumber(ARGV[2])
if currentVersion then
  if currentVersion > nextVersion then return 0 end
  if currentVersion == nextVersion then
    local currentRank = 0
    if currentState == 'pending' then currentRank = 1
    elseif currentState == 'terminal' then currentRank = 2
    elseif currentState == 'suppressed' then currentRank = 3
    end
    if currentRank >= tonumber(ARGV[3]) then return 0 end
  end
end
redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[4])
redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[4])
return 1
`;

interface SlackReservationStore {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

function reservationEventVersion(eventAt: string, exactVersion?: string): string {
  if (exactVersion) {
    try {
      return BigInt(exactVersion).toString();
    } catch {
      throw new Error('Slack reservation event version is invalid');
    }
  }
  const eventMillis = Date.parse(eventAt);
  if (!Number.isFinite(eventMillis)) throw new Error('Slack reservation event time is invalid');
  return String(BigInt(eventMillis) * 1000n + 999n);
}

/**
 * Builds the tenant-scoped idempotency key for one Slack classification attempt.
 *
 * @param tenantId - Tenant that owns the inbound Slack subscription.
 * @param channel - Slack channel containing the message.
 * @param externalMessageId - Immutable Slack message timestamp.
 */
export const slackClassifyReservationKey = (
  tenantId: string,
  channel: string,
  externalMessageId: string,
): string => `classify:msg:${tenantId}:${channel}:${externalMessageId}`;

/**
 * Advances the transient classify state only when its provider event version is current.
 *
 * @param redis - Redis-compatible store that executes the atomic transition.
 * @param key - Stable Slack message reservation key.
 * @param state - State produced by this processing phase.
 * @param eventAt - Provider event time used to order racing writes.
 * @param eventVersion - Exact provider ordering value when it is finer than JavaScript Date.
 * @param ttlSeconds - Lifetime applied to both state and version keys.
 */
export async function writeSlackClassifyReservation(
  redis: SlackReservationStore,
  key: string,
  state: SlackClassifyReservationState,
  eventAt: string,
  eventVersion?: string,
  ttlSeconds = 86_400,
): Promise<{ applied: boolean }> {
  const version = reservationEventVersion(eventAt, eventVersion);
  const applied = await redis.eval(
    WRITE_RESERVATION_LUA,
    2,
    key,
    `${key}:event-version`,
    state,
    version,
    String(STATE_RANK[state]),
    String(ttlSeconds),
  );
  return { applied: applied === 1 };
}
