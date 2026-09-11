import { makeFakeGenerator } from '../engine/fake';
import { parseLifecycleCommand } from './responder-command.fixture';

/** Script orchestration decisions only; actual semantic accuracy is evaluated separately. */
export function responderGenerator() {
  return makeFakeGenerator((prompt) => {
    const data = JSON.parse(prompt) as { currentResponderMessage?: string; newer?: string[] };
    if (data.newer)
      return {
        material: !data.newer.every((message) =>
          /^(?:thanks|thank you|acknowledged)[.!]?$/i.test(message.trim()),
        ),
        reason: 'Scripted classification of newer responder context.',
      };
    const message = data.currentResponderMessage ?? '';
    const command = parseLifecycleCommand(message.replace(/^(?:let[’']s\s+|please\s+)/i, ''));
    if (command)
      return { kind: 'action', target: 'current', to: command.to, reason: command.reason };
    if (/^close incident (?:once|in the other)/i.test(message))
      return {
        kind: 'clarify',
        target: 'ambiguous',
        to: null,
        reason: 'Please clarify the current-case action.',
      };
    return {
      kind: 'investigate',
      target: 'current',
      to: null,
      reason: 'Investigate the responder request.',
    };
  });
}
