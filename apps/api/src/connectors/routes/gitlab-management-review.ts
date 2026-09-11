import { createHash } from 'node:crypto';
import { gitLabSmeeUrl, gitLabWebhookSecret, gitLabWebhookSigningToken } from '@sre/connectors';
import { GITLAB_HOOK_POLICY_VERSION, GITLAB_MANAGED_HOOK_EVENTS } from '@sre/contracts';
import type { connectorConfigs } from '@sre/db';
import { parseGitLabSettings } from '../helpers';

/** Build exactly the scope and receiver the administrator authorizes, never a raw management token. */
export function gitLabManagementReview(
  connection: typeof connectorConfigs.$inferSelect,
  credential: string | null,
  publicDestination: unknown,
) {
  const settings = parseGitLabSettings(connection.settings);
  if (
    !settings?.groupId ||
    !settings.groupPath ||
    settings.eventStrategy !== 'managed_projects' ||
    !['direct', 'smee'].includes(settings.eventTransport ?? '') ||
    !credential ||
    !connection.enabled
  )
    throw new Error(
      'Save and verify a managed-project connection with event delivery before authorizing management.',
    );
  const destination =
    settings.eventTransport === 'smee' ? gitLabSmeeUrl(credential) : publicDestination;
  if (typeof destination !== 'string') throw new Error('The event receiver is not configured.');
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    throw new Error('A valid HTTPS receiver is required.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (settings.eventTransport !== 'smee' &&
      !url.pathname.endsWith(`/webhooks/gitlab/${connection.webhookKey}`))
  )
    throw new Error('The receiver must be the HTTPS webhook address for this connection.');
  const webhookSecret = gitLabWebhookSecret(credential);
  const signingToken = gitLabWebhookSigningToken(credential);
  if (!webhookSecret && !signingToken) throw new Error('Configure webhook authentication first.');
  const scope = {
    baseUrl: settings.baseUrl,
    groupId: String(settings.groupId),
    groupPath: settings.groupPath,
    transport: settings.eventTransport,
    destinationDigest: createHash('sha256').update(destination).digest('hex'),
    events: GITLAB_MANAGED_HOOK_EVENTS,
    policyVersion: GITLAB_HOOK_POLICY_VERSION,
  };
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        connectorId: connection.id,
        lifecycleVersion: connection.lifecycleVersion,
        scope,
      }),
    )
    .digest('hex');
  return {
    scope,
    digest,
    destination,
    webhookSecret,
    signingToken,
    receiverLabel:
      settings.eventTransport === 'smee' ? 'Saved Smee channel (encrypted)' : destination,
  };
}
