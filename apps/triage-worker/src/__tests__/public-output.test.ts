import { describe, expect, test } from 'vitest';
import { publicModelText } from '../public-output';
import { INTERNAL_REFERENCE } from './internal-reference.fixture';

describe('publicModelText', () => {
  test.each([
    `Per ${INTERNAL_REFERENCE} I won't apply this. Keep the action recommend-only (${INTERNAL_REFERENCE}).`,
    'RFC 9110 defines the HTTP semantics.',
    'RFC-0042 is a customer document.',
    'RFC_0042 is a customer document.',
    'RFC#0042 is a customer document.',
    'RFC/0042 is a customer document.',
    'DEC/0015 requires a human decision.',
    'DEC  0015 requires a human decision.',
    'DEC_0015 requires a human decision.',
    'DEC - 0015 requires a human decision.',
    'DEC–0015 requires a human decision.',
    `[${INTERNAL_REFERENCE}](https://internal.example/decisions) applies.`,
    'See https://internal.example/wiki/rfc-0042 before acting.',
    `See ${INTERNAL_REFERENCE}`,
    'packages/hub/src/hub.ts calls finalizeRecovery() per DEC 0015 before replying.',
    '@sre/hub package ConversationHub is the affected package.',
    '/srv/sre-platform/apps/api/src/incidents.ts uses report_recovery.',
    'C:\\\\srv\\\\sre-platform\\\\packages\\\\hub\\\\src\\\\hub.ts invokes search_runbooks.',
    'ConversationHub.finalizeRecovery() completed.',
    'function finalizeRecovery uses report_recovery.',
    'ConversationHub . finalizeRecovery() used lockIncidentWorkTx.',
    'apps/anomaly-detector/src/index.ts emitted a result.',
    'apps/dev-tunnels/src/index.ts opened a tunnel.',
    'BLAMELESS_SYSTEM_PROMPT shaped this via makePostmortemHandler.',
    'The assessment-grade run and postmortem_generate job ran.',
    'stripHumanIdentifiers() removed a name; makeGradeHandler judged.',
    'Case-sensitive paths and Unicode identifiers: packages/db/ﬁxtures/Ａ.ts',
  ])('preserves operational identifiers verbatim: %s', (content) => {
    expect(publicModelText(content)).toBe(content);
  });

  test('preserves monitored-application references while retaining secret scrubbing', () => {
    expect(
      publicModelText(
        'GitLab MR !123 changed apps/v1 scheduling and checkout.finalizeRecovery; token sk-abcdefghijklmnopqrstuvwxyz123456.',
      ),
    ).toBe(
      'GitLab MR !123 changed apps/v1 scheduling and checkout.finalizeRecovery; token [REDACTED].',
    );
  });
});
