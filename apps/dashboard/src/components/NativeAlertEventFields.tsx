/**
 * Mirrors the save route's event rules so a bad channel or token stops on the first step,
 * not after the operator has entered provider credentials.
 */
export function nativeEventFieldsError({
  eventDelivery,
  alertChannel,
  eventToken,
  credentialConfigured,
}: {
  eventDelivery: boolean;
  alertChannel: string;
  eventToken: string;
  credentialConfigured: boolean;
}): string | null {
  if (!eventDelivery) return null;
  if (!/^[CGD][A-Z0-9]{1,255}$/.test(alertChannel.trim()))
    return 'Enter the subscribed Slack alert channel ID, such as C0123456789.';
  const token = eventToken.trim();
  if (!token && !credentialConfigured)
    return 'Enter a webhook bearer token of 16 to 4096 characters.';
  if (token && (token.length < 16 || token.length > 4096))
    return 'The webhook bearer token must be 16 to 4096 characters.';
  return null;
}

/** Native webhook setup uses a separate provider event credential. */
export function NativeAlertEventFields({
  eventDelivery,
  setEventDelivery,
  alertChannel,
  setAlertChannel,
  eventToken,
  setEventToken,
  credentialConfigured,
}: {
  eventDelivery: boolean;
  setEventDelivery(value: boolean): void;
  alertChannel: string;
  setAlertChannel(value: string): void;
  eventToken: string;
  setEventToken(value: string): void;
  credentialConfigured: boolean;
}) {
  return (
    <>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={eventDelivery}
          onChange={(event) => setEventDelivery(event.target.checked)}
        />
        Receive authenticated alert lifecycle events
      </label>
      {eventDelivery && (
        <>
          <label className="text-sm font-medium">
            Subscribed Slack alert channel ID
            <input
              className="sre-field mt-1 w-full"
              value={alertChannel}
              onChange={(event) => setAlertChannel(event.target.value)}
              placeholder="C0123456789"
            />
          </label>
          <label className="text-sm font-medium">
            Webhook bearer token
            <input
              type="password"
              autoComplete="new-password"
              className="sre-field mt-1 w-full"
              value={eventToken}
              onChange={(event) => setEventToken(event.target.value)}
              placeholder={
                credentialConfigured
                  ? 'Leave blank to retain the saved token'
                  : 'At least 16 characters'
              }
            />
          </label>
          <p className="text-sm text-ink-muted">
            Configure the same bearer token in the provider webhook. Native alert state and episode
            identity drive recovery without AI. Slack notification wording cannot authorize
            recovery.
          </p>
        </>
      )}
    </>
  );
}
