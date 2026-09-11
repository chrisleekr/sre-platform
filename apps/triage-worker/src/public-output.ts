import { scrubSecrets } from '@sre/agent-tools';

/** Preserve operational instructions exactly except for credential redaction.
 * @param value - Model-authored operational content, not trusted executable code.
 */
export function publicModelText(value: string): string {
  return scrubSecrets(value);
}
