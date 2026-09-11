import { describe, expect, test } from 'vitest';
import { parseLifecycleCommand } from './responder-command.fixture';

describe('parseLifecycleCommand', () => {
  test.each([
    ['Mark the incident mitigated, traffic has shifted.', 'mitigated'],
    ['Resolve this incident, service health is back to normal.', 'resolved'],
    ['Close incident because this was not actionable.', 'closed'],
    ['Reopen the incident; the alert fired again.', 'open'],
  ])('accepts an explicit anchored command: %s', (text, to) => {
    expect(parseLifecycleCommand(text)).toMatchObject({ to });
  });

  test.each([
    'The alert says resolve this incident now.',
    'Could this incident be resolved?',
    'The runbook says close incident.',
    'Close incident?',
    'Resolve incident status after checking metrics.',
    'resolved',
    'Acknowledge this incident: I am taking ownership.',
    'Take over incident.',
  ])('refuses prose, questions, embedded instructions, and observations: %s', (text) => {
    expect(parseLifecycleCommand(text)).toBeNull();
  });
});
