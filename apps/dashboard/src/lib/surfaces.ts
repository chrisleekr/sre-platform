/**
 * A connected surface as projected by GET /surfaces. The row's existence IS the connection —
 * there is no enable flag and no channel to post to (the AI answers in the alert's own thread).
 * Secret material is never returned: only presence booleans (`hasAppToken`/`hasBotToken`), so the
 * page can show status without ever holding a credential. [D5, write-only]
 */
export interface SurfaceSummary {
  id: string;
  surface: string; // 'slack'
  botUserId: string | null; // resolved by a successful test; null until then
  hasAppToken: boolean;
  hasBotToken: boolean;
  runtime?: {
    socket: {
      state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
      connectedAt: string | null;
      updatedAt: string;
    } | null;
    inbound: {
      latest: {
        state: 'queued' | 'processing' | 'processed' | 'retrying' | 'dropped';
        outcome: string | null;
        classificationOutcome: string | null;
        classificationUpdatedAt: string | null;
        terminalDisposition?: string | null;
        terminalDispositionAt?: string | null;
        terminalDispositionEventAt?: string | null;
        acceptedAt: string;
        completedAt: string | null;
        jobStatus: string | null;
        attemptCount: number;
        errorCode: string | null;
      } | null;
      pendingCount: number;
      failedLast24Hours: number;
    } | null;
  };
}

export interface SurfacesResponse {
  surfaces: SurfaceSummary[];
}

/**
 * The Slack surface upsert body. Secrets are write-only: omit `appToken`/`botToken` to leave the
 * stored value untouched; send a new value to rotate it. The API never echoes them back.
 */
export interface SaveSlackSurfaceInput {
  botUserId?: string;
  appToken?: string;
  botToken?: string;
}

/**
 * Result of POST /surfaces/slack/test after both tokens and their shared app identity are validated.
 *
 * `warning` is ONE-DIRECTIONAL. Present, it names scopes that are DEFINITELY missing. Absent, it proves
 * nothing at all: `users:read.email` cannot be detected (without it `users.info` still succeeds and merely
 * omits the email), so there is no "scopes OK" to report and its absence must never be rendered as one.
 * The connection still works when it is set, hence a passing result that carries a warning.
 */
export type SlackTestResult =
  { ok: true; botUserId: string; team: string; warning?: string } | { ok: false; error: string };

/** One channel we listen to. `channel` is the Slack ID (what events carry); `name` is display only. */
export interface SlackChannel {
  channel: string;
  name: string | null;
  enabled: boolean;
}

export interface SlackChannelsResponse {
  channels: SlackChannel[];
}

/**
 * A channel the bot can SEE, from Slack's own conversations.list. The operator picks from these
 * rather than typing: Slack events only ever carry channel IDs, so a hand-typed "#name" never matches.
 */
export interface AvailableChannel {
  id: string;
  name: string;
}

export interface AvailableChannelsResponse {
  channels: AvailableChannel[];
  /** The API hit its conversations.list page cap: the workspace has channels this list does not show
   *Silence here sends the operator hunting for a channel that is simply not in the picker. */
  truncated: boolean;
}
