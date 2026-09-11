import { describe, expect, test } from 'vitest';
// the shared, content-addressed approvals idempotency key, used by BOTH engines (loop.ts +
// openai.ts). RED today: the module does not exist; the Claude loop keys on the provider ToolCall.id
// and the OpenAI engine carries its own private copy under an `openai:` prefix.
import { approvalActionId } from '../approval-id';

const PROMPT = 'Restart checkout?';
const OPTIONS = [
  { id: 'approve', label: 'Approve' },
  { id: 'deny', label: 'Deny' },
];

describe('approvalActionId', () => {
  test('C8 the key is a content hash of (prompt, options), not a provider id', () => {
    expect(approvalActionId(PROMPT, OPTIONS)).toMatch(/^approval:[0-9a-f]{32}$/);
  });

  test('C9 the same proposal always yields the same key (a redelivery collapses to one row)', () => {
    // createApproval upserts on (tenant, incident, action_id): a redelivered resume re-invokes the
    // provider, which mints a FRESH tool-call id — the key must not move with it.
    expect(approvalActionId(PROMPT, OPTIONS)).toBe(approvalActionId(PROMPT, OPTIONS));
  });

  test('C11 a different PROMPT yields a different key (no false collision)', () => {
    // A collision here would attach a human's decision to an action they were never shown.
    expect(approvalActionId('Roll back checkout?', OPTIONS)).not.toBe(
      approvalActionId(PROMPT, OPTIONS),
    );
  });

  test('C11 a different OPTION SET yields a different key', () => {
    expect(approvalActionId(PROMPT, [{ id: 'approve', label: 'Approve' }])).not.toBe(
      approvalActionId(PROMPT, OPTIONS),
    );
    // Order is part of the identity: the buttons a human sees differ, so the proposal differs.
    expect(approvalActionId(PROMPT, [...OPTIONS].reverse())).not.toBe(
      approvalActionId(PROMPT, OPTIONS),
    );
  });

  test('an empty option set still produces a non-empty key', () => {
    // An empty-string key would collide every option-less proposal in an incident onto one row.
    expect(approvalActionId(PROMPT, [])).toMatch(/^approval:[0-9a-f]{32}$/);
    expect(approvalActionId(PROMPT, [])).not.toBe(approvalActionId(PROMPT, OPTIONS));
  });

  test('a salt re-keys deterministically (the worker re-opens a spent proposal without a nonce)', () => {
    // The worker salts a DECIDED proposal to mint a fresh row for a re-proposed action, and re-walks the
    // SAME salted chain on a redelivery — so a salt must move the key yet stay deterministic per salt.
    const unsalted = approvalActionId(PROMPT, OPTIONS);
    const salted = approvalActionId(PROMPT, OPTIONS, 'incident-1#1');
    expect(salted).not.toBe(unsalted);
    expect(salted).toMatch(/^approval:[0-9a-f]{32}$/);
    expect(approvalActionId(PROMPT, OPTIONS, 'incident-1#1')).toBe(salted); // deterministic per salt
    expect(approvalActionId(PROMPT, OPTIONS, 'incident-1#2')).not.toBe(salted); // distinct across salts
  });
});
