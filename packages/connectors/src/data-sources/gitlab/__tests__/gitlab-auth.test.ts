import { describe, expect, test } from 'vitest';
import {
  gitLabAccessToken,
  gitLabCredentialBundle,
  gitLabSmeeUrl,
  gitLabWebhookSecret,
  gitLabWebhookSigningToken,
} from '../auth';

describe('GitLab credential bundle', () => {
  test('keeps the access token and webhook verifier in one write-only value', () => {
    const signingToken = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
    const stored = gitLabCredentialBundle('glpat-read-only', {
      webhookSecret: 'webhook-secret-at-least-16',
      webhookSigningToken: signingToken,
      smeeUrl: 'https://smee.io/gitlab-events',
    });
    expect(gitLabAccessToken(stored)).toBe('glpat-read-only');
    expect(gitLabWebhookSecret(stored)).toBe('webhook-secret-at-least-16');
    expect(gitLabWebhookSigningToken(stored)).toBe(signingToken);
    expect(gitLabSmeeUrl(stored)).toBe('https://smee.io/gitlab-events');
  });

  test('reads legacy raw and v2 credentials but rejects malformed JSON credentials', () => {
    expect(gitLabAccessToken('glpat-legacy')).toBe('glpat-legacy');
    expect(gitLabWebhookSecret('glpat-legacy')).toBeNull();
    expect(
      gitLabWebhookSecret(
        JSON.stringify({
          version: 2,
          token: 'glpat-v2',
          webhookSecret: 'legacy-webhook-secret',
        }),
      ),
    ).toBe('legacy-webhook-secret');
    expect(gitLabAccessToken('{"version":2,"token":""}')).toBeNull();
    expect(
      gitLabAccessToken(
        JSON.stringify({ version: 3, token: 'glpat-test', smeeUrl: 'https://example.com/no' }),
      ),
    ).toBeNull();
  });
});
