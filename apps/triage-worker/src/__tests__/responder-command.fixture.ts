import type { IncidentStatus } from '@sre/db';

export interface LifecycleCommand {
  to: IncidentStatus;
  reason: string;
}

const COMMANDS: Array<{ to: IncidentStatus; pattern: RegExp }> = [
  {
    to: 'mitigated',
    pattern: /^(?:mitigate|mark\s+(?:(?:this|the)\s+)?incident\s+mitigated)\b(.*)$/i,
  },
  { to: 'resolved', pattern: /^resolve\s+(?:(?:this|the)\s+)?incident\b(.*)$/i },
  { to: 'closed', pattern: /^close\s+(?:(?:this|the)\s+)?incident\b(.*)$/i },
  { to: 'open', pattern: /^reopen\s+(?:(?:this|the)\s+)?incident\b(.*)$/i },
];

/** Script legacy command fixtures; production intent is model-interpreted and transactionally authorized.
 * @param text - Synthetic responder input.
 */
export function parseLifecycleCommand(text: string): LifecycleCommand | null {
  const input = text.trim();
  if (input.endsWith('?')) return null;
  for (const command of COMMANDS) {
    const match = command.pattern.exec(input);
    if (!match) continue;
    const rawDetail = match[1]!.trim();
    if (rawDetail && !/^(?:[,:;.-]|because\b)/i.test(rawDetail)) continue;
    const detail = rawDetail.replace(/^(?:[,:;.-]|because\b)\s*/i, '').trim();
    return {
      to: command.to,
      reason: detail || `Responder explicitly requested lifecycle ${command.to}.`,
    };
  }
  return null;
}
