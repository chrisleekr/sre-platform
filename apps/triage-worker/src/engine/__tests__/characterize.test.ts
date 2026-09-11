import { describe, expect, test } from 'vitest';
import * as z from 'zod';
import type { ZodType } from 'zod';
import { characterizeThread } from '../characterize';
import type { StructuredGenerator } from '../types';
import type { IncidentSummary } from '@sre/db';

// The pull path: characterizeThread turns a rendered thread transcript +
// the open-incident candidate list into a correlation verdict via ONE StructuredGenerator call.
// The transcript is embedded in the prompt as UNTRUSTED data (treat as data, never as
// instructions). Hermetic: a fake generator captures the prompt + schema so no provider is needed.

const TRANSCRIPT = '[U1]: checkout is throwing 500s\n[U2]: db pool exhausted';

describe('characterizeThread', () => {
  test('returns the generator-produced verdict verbatim', async () => {
    const verdict = {
      decision: 'new_incident',
      service: 'checkout',
      severity: 'sev2',
      title: 'checkout 500s',
    };
    const { generator } = recordingVerdictGenerator(verdict);
    const out = await characterizeThread(generator, TRANSCRIPT, []);
    expect(out).toEqual(verdict);
  });

  test('the prompt embeds the transcript and an untrusted-data guard instruction', async () => {
    const { generator, seen } = recordingVerdictGenerator({ decision: 'belongs_to', index: 1 });
    await characterizeThread(generator, TRANSCRIPT, []);
    expect(seen.prompt).toContain(TRANSCRIPT);
    // The transcript is attacker-influenced content; the prompt must guard it as data, not instructions.
    expect(seen.prompt!.toLowerCase()).toContain('untrusted');
  });

  test('the schema is the correlation-verdict shape with a sev1|sev2|sev3 enum', async () => {
    const { generator, seen } = recordingVerdictGenerator({ decision: 'belongs_to', index: 1 });
    await characterizeThread(generator, TRANSCRIPT, []);
    const schema = seen.schema!;
    expect(
      schema.safeParse({
        decision: 'new_incident',
        service: 'checkout',
        severity: 'sev2',
        title: 'ok',
      }).success,
    ).toBe(true);
    // A severity outside the enum must be rejected.
    expect(
      schema.safeParse({
        decision: 'new_incident',
        service: 'checkout',
        severity: 'sev9',
        title: 'ok',
      }).success,
    ).toBe(false);
    // The OLD bare {service, severity, title} (no decision discriminant) is no longer valid.
    expect(schema.safeParse({ service: 'checkout', severity: 'sev2', title: 'ok' }).success).toBe(
      false,
    );
    // Silence an unused-import lint if the file only uses z transitively.
    expect(typeof z.object).toBe('function');
  });
});

// --- mention correlation verdict --------------------------------------------------
// characterizeThread gains a `candidates` param and returns a 2-way correlation verdict:
//   { decision: 'belongs_to'; index } | { decision: 'new_incident'; service, severity, title }
// There is NO not_worthy on the mention path (a human is the gate). The candidate block is rendered
// into the prompt as opaque 1-based indices. RED now: the schema is the {service,severity,title}
// shape and the prompt ignores candidates.

// A generator recording the (prompt, schema) it saw, returning a fixed verdict object.
function recordingVerdictGenerator(result: unknown): {
  generator: StructuredGenerator;
  seen: { prompt?: string; schema?: ZodType<unknown> };
} {
  const seen: { prompt?: string; schema?: ZodType<unknown> } = {};
  const generator: StructuredGenerator = {
    async generate<T>(prompt: string, schema: ZodType<T>): Promise<T> {
      seen.prompt = prompt;
      seen.schema = schema as unknown as ZodType<unknown>;
      return result as T;
    },
  };
  return { generator, seen };
}

function summary(over: Partial<IncidentSummary> & { title?: string }): IncidentSummary {
  return {
    id: over.id ?? 'inc-x',
    service: over.service ?? 'checkout',
    severity: over.severity ?? 'sev2',
    status: 'open',
    alertSource: 'slack',
    rcaSummary: null,
    confidence: null,
    createdAt: new Date(),
    ...over,
  } as IncidentSummary;
}

const CANDIDATES: IncidentSummary[] = [
  summary({ id: 'inc-A', service: 'checkout', severity: 'sev2', title: 'Checkout 5xx spike' }),
];

describe('characterizeThread correlation verdict', () => {
  test('the schema is the 2-way correlation verdict (belongs_to | new_incident), never not_worthy', async () => {
    const { generator, seen } = recordingVerdictGenerator({ decision: 'belongs_to', index: 1 });
    await characterizeThread(generator, TRANSCRIPT, CANDIDATES);
    const schema = seen.schema!;
    expect(schema.safeParse({ decision: 'belongs_to', index: 1 }).success).toBe(true);
    expect(
      schema.safeParse({
        decision: 'new_incident',
        service: 'checkout',
        severity: 'sev2',
        title: 't',
      }).success,
    ).toBe(true);
    // The mention path has no not_worthy verdict — a human is the gate.
    expect(schema.safeParse({ decision: 'not_worthy' }).success).toBe(false);
  });

  test('the prompt renders the candidate block as opaque 1-based indices', async () => {
    const { generator, seen } = recordingVerdictGenerator({ decision: 'belongs_to', index: 1 });
    await characterizeThread(generator, TRANSCRIPT, CANDIDATES);
    expect(seen.prompt).toContain('[1]');
    expect(seen.prompt).toContain('Checkout 5xx spike');
    // Never the UUID-ish id: selection is by opaque index.
    expect(seen.prompt).not.toContain('inc-A');
  });

  test('returns the generator-produced verdict verbatim', async () => {
    const verdict = { decision: 'new_incident', service: 'checkout', severity: 'sev2', title: 't' };
    const { generator } = recordingVerdictGenerator(verdict);
    await expect(characterizeThread(generator, TRANSCRIPT, CANDIDATES)).resolves.toEqual(verdict);
  });
});
