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
