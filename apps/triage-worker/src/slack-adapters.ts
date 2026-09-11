// Slack surface adapters the classify consumer and the signal reminder need. Pure construction,
// lifted out of the worker entrypoint so that file stays a list of subsystems rather than their
// wiring. Every adapter resolves the tenant's bot token from the SecretStore at point of use and
// never persists it.

import {
  makeSlackThreadReader,
  makeSlackPoster,
  slackChatGetPermalink,
  type FetchLike,
} from '@sre/surfaces';
import { surfaceBotTokenKey, type SecretStore } from '@sre/db';
import { makeSignalReminderPoster } from './signal-maintenance';

/**
 * Builds the Slack adapters the triage worker binds into its consumers.
 *
 * @param secrets - Tenant secret store the bot token is resolved from at point of use.
 */
export function makeSlackAdapters(secrets: SecretStore) {
  // The one token resolution every adapter below shares: at point of use, never persisted.
  const getToken = (tenantId: string) => secrets.get(tenantId, surfaceBotTokenKey('slack'));
  // Slack thread reader for the mention pull path: reads a whole thread via
  // conversations.replies.
  const slackThreadReader = makeSlackThreadReader({ getToken });
  // Cross-thread breadcrumb poster: when a mention belongs_to an incident bound to a
  // different thread, post a one-line pointer into the human's thread (the dialogue consolidates in the
  // canonical thread). Called detached best-effort by the consumer, so a missing token / post failure
  // never fails the job.
  const slackPoster = makeSlackPoster(globalThis.fetch as unknown as FetchLike);
  const breadcrumbPoster = {
    async post(
      tenantId: string,
      thread: { channel: string; threadId: string },
      message: string,
    ): Promise<void> {
      const token = await getToken(tenantId);
      if (!token) return; // no bot token: skip the breadcrumb (mirrors the fan-out / thread-reader).
      // The channel addresses the API call; the thread id only means anything inside it.
      await slackPoster.post({ token, channel: thread.channel }, thread.threadId, {
        id: '',
        incidentId: '',
        author: 'system',
        kind: 'text',
        content: message,
        createdAt: new Date().toISOString(),
        // The ONLY producer that opts out of mrkdwn escaping: breadcrumbText already renders the
        // permalink as `<url|text>`, which IS Slack's link syntax, so escaping it would print the markup
        // instead of the deep-link. Safe to opt out because the URL comes from Slack's own
        // chat.getPermalink over Slack-generated ids and the surrounding copy is a fixed literal, so no
        // human or LLM input reaches this string. Any new producer must leave the flag off and be escaped.
        preformatted: true,
      });
    },
  };
  const signalReminderPoster = makeSignalReminderPoster({
    getToken,
    postWithToken: async (token, thread, message) => {
      await slackPoster.post({ token, channel: thread.channel }, thread.threadId, {
        id: '',
        incidentId: '',
        author: 'system',
        kind: 'text',
        content: message,
        createdAt: new Date().toISOString(),
      });
    },
  });
  // Deep-links that breadcrumb to the canonical thread. A SEPARATE dep from the poster above, which
  // stays narrowed to need no token wiring. chat.getPermalink needs no OAuth scope, so the tenant's
  // existing token suffices with no re-install. No token degrades to null, mirroring the poster's own
  // missing-token skip.
  //
  // Database and decrypt failures intentionally reach the consumer's generic-breadcrumb fallback.
  const resolvePermalink = async (
    tenantId: string,
    channel: string,
    threadTs: string,
  ): Promise<string | null> => {
    const token = await getToken(tenantId);
    if (!token) return null;
    return slackChatGetPermalink(
      globalThis.fetch as unknown as FetchLike,
      token,
      channel,
      threadTs,
    );
  };

  return { slackThreadReader, breadcrumbPoster, signalReminderPoster, resolvePermalink };
}
