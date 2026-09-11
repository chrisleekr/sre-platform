import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import {
  buildResumePrompt,
  buildRecoveryPrompt,
  buildInvestigationPrompt,
  buildUserPrompt,
  measureEvidenceBlock,
  renderEvidenceBlock,
  renderEvidence,
  EVIDENCE_BLOCK_SEPARATOR,
  RECOVERY_SYSTEM_PROMPT,
  TRIAGE_SYSTEM_PROMPT,
} from '../shared';
import { SHORTEST_EVIDENCE_BLOCK_CHARS } from '@sre/db';
import { makeClaudeProvider, type AnthropicLike } from '../claude';
import { makeOpenAIProvider, type OpenAILike } from '../openai';

test('buildUserPrompt includes the service and severity', () => {
  const p = buildUserPrompt({
    incident: {
      id: 'i',
      tenantId: 't',
      service: 'checkout',
      severity: 'sev2',
      fingerprint: 'fp',
      alertSource: 'datadog',
    },
  });
  expect(p).toContain('checkout');
  expect(p).toContain('sev2');
});

test('buildUserPrompt appends injected context (the blast-radius brief) after the incident header', () => {
  const p = buildUserPrompt({
    incident: {
      id: 'i',
      tenantId: 't',
      service: 'checkout',
      severity: 'sev2',
      fingerprint: 'fp',
      alertSource: 'datadog',
    },
    context: 'Blast radius for "checkout":\n- Direct (hard down):\n  - web',
  });
  expect(p).toContain('Blast radius for "checkout"');
  // Context follows the incident header so the agent reads what happened, then what is affected.
  expect(p.indexOf('Incident on service')).toBeLessThan(p.indexOf('Blast radius'));
});

test('buildInvestigationPrompt renders durable evidence exactly once', () => {
  const prompt = buildInvestigationPrompt({
    incident: {
      id: 'i',
      tenantId: 't',
      service: 'checkout',
      severity: 'sev2',
      fingerprint: 'fp',
      alertSource: 'alertmanager',
    },
    evidence: [
      {
        id: 'evidence-1',
        tool: 'query_metrics',
        input: { query: 'error_rate' },
        output: { value: 0.12 },
        createdAt: '2026-08-31T01:00:00.000Z',
      },
    ],
  });

  expect(prompt).toContain('Evidence already gathered');
  expect(prompt).toContain('Evidence evidence-1');
  expect(prompt).toContain('query_metrics');
  expect(prompt).toContain('error_rate');
  expect(prompt.match(/Evidence already gathered/g)).toHaveLength(1);
});

test('buildResumePrompt instructs the constrained human-executed action terminal', () => {
  const prompt = buildResumePrompt({
    incident: {
      id: 'i',
      tenantId: 't',
      service: 'checkout',
      severity: 'sev2',
      fingerprint: 'fp',
      alertSource: 'datadog',
    },
    humanMessage: 'What should I do?',
    prior: [],
  });

  expect(prompt).toContain('suggest_action');
  expect(prompt).toContain('level L2 or L3');
  expect(prompt).toContain('explanation');
  expect(prompt).toContain('exact command or rollback reference');
  expect(prompt).toContain('human-executed');
  expect(prompt).not.toContain('request_approval');
});

test('buildRecoveryPrompt carries the model-selected reason into its scheduled successor', () => {
  const prompt = buildRecoveryPrompt({
    incident: {
      id: 'i',
      tenantId: 't',
      service: 'checkout',
      severity: 'sev2',
      fingerprint: 'fp',
      alertSource: 'alertmanager',
    },
    prior: [],
    signalSummary: 'All provider signals are resolved.',
    attempt: 2,
    maxChecks: 3,
    scheduledReason: 'The deployment is still converging.',
  });

  expect(prompt).toContain('automated recovery check 2 of 3');
  expect(prompt).toContain('The deployment is still converging.');
});

describe('TRIAGE_SYSTEM_PROMPT investigation sequence', () => {
  test('lays out the ten investigation steps in order', () => {
    const orderedSteps = [
      '1. Blast radius',
      '2. Deploy correlation',
      '3. Logs',
      '4. Code evidence',
      '5. Golden signals',
      '6. Infrastructure',
      '7. Runbooks',
      '8. Rank hypotheses',
      '9. Recommended action',
      '10. Escalation',
    ];
    const indices = orderedSteps.map((step) => TRIAGE_SYSTEM_PROMPT.indexOf(step));
    expect(indices.every((i) => i >= 0)).toBe(true); // every step label is present
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]!); // strictly increasing → in order
    }
  });

  test('names the four golden signals', () => {
    for (const signal of ['latency', 'traffic', 'errors', 'saturation']) {
      expect(TRIAGE_SYSTEM_PROMPT).toContain(signal);
    }
  });

  test('names the always-present platform tools but not per-connector tools', () => {
    // Platform evidence tools and report_findings are bound for every tenant, so the prompt may
    // name them when their safety contract matters.
    for (const tool of ['search_runbooks', 'investigate_code', 'report_findings']) {
      expect(TRIAGE_SYSTEM_PROMPT).toContain(tool);
    }
    // Per-connector tools are bound dynamically per tenant via the SDK spec, so the shared
    // prompt must not hardcode the removed fixed signal-tool names.
    //
    // These stale fixed-tool names are DELIBERATE and must not be "tidied" to current ones: the
    // assertion is that they are ABSENT, so naming a live tool here would invert the test into one the
    // prompt is meant to fail.
    for (const removed of [
      'fetch_logs',
      'fetch_metrics',
      'fetch_commits',
      'fetch_pipeline',
      'fetch_infra_state',
    ]) {
      expect(TRIAGE_SYSTEM_PROMPT).not.toContain(removed);
    }
  });

  // a surfaced runbook (seed or on-demand) is an ADVISORY CANDIDATE grounded in the
  // incident thread — the agent must verify it fits the same issue, may reject it, must not fabricate,
  // must cite it, and recommends only (no auto-remediation). RED until the guard is added to the prompt.
  test('grounds surfaced runbooks as advisory candidates, not ground truth', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('advisory candidate');
    expect(TRIAGE_SYSTEM_PROMPT.toLowerCase()).toContain('verify');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('recommend-only');
  });

  // the prompt-injection guard enumerates runbook/knowledge-base content (seed + tool)
  // as untrusted, not just alert/topology/tool-result text.
  test('lists runbook and knowledge-base content as untrusted data', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('runbook and knowledge-base');
  });

  // time-windowed queries anchor to the alert onset, not wall-clock now, so an alert
  // reported late still queries when it fired; fall back to now-15m or ask the SRE.
  test('instructs anchoring time-windowed queries to the alert onset', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('incident onset time from the alert payload');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('last 15 minutes');
  });

  test('states the report_findings output contract', () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain('report_findings');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('summary');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('confidence');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('0-100');
    expect(TRIAGE_SYSTEM_PROMPT).toContain('rankedHypotheses');
  });

  test('keeps internal architecture references out of responder-facing model output', () => {
    for (const prompt of [TRIAGE_SYSTEM_PROMPT, RECOVERY_SYSTEM_PROMPT]) {
      expect(prompt).toContain('responder-facing operational language');
      expect(prompt).not.toMatch(/\b(?:ADR|RFC)-\d+\b/u);
    }
  });

  test('both engines thread it in as their system text', async () => {
    // Claude API-key path: the provider sends the plain prompt string as `system`.
    const createApiKey = vi.fn().mockResolvedValue({ stop_reason: 'end_turn', content: [] });
    const apiKeyProvider = makeClaudeProvider(
      { messages: { create: createApiKey } } as AnthropicLike,
      'apikey',
      'claude-opus-4-8',
    );
    await apiKeyProvider.call(
      TRIAGE_SYSTEM_PROMPT,
      [apiKeyProvider.userMsg('u')],
      apiKeyProvider.toolSpecs([]),
    );
    expect((createApiKey.mock.calls[0]![0] as { system: string }).system).toContain(
      TRIAGE_SYSTEM_PROMPT,
    );

    // Claude OAuth path: the prompt survives as a system block alongside the Code identifier.
    const createOauth = vi.fn().mockResolvedValue({ stop_reason: 'end_turn', content: [] });
    const oauthProvider = makeClaudeProvider(
      { messages: { create: createOauth } } as AnthropicLike,
      'oauth',
      'claude-opus-4-8',
    );
    await oauthProvider.call(TRIAGE_SYSTEM_PROMPT, [], oauthProvider.toolSpecs([]));
    const oauthSystem = (createOauth.mock.calls[0]![0] as { system: Array<{ text: string }> })
      .system;
    expect(oauthSystem.map((b) => b.text).join('\n')).toContain(TRIAGE_SYSTEM_PROMPT);

    // OpenAI path: the provider sends the prompt as the first system message.
    const createOpenAI = vi.fn().mockResolvedValue({ choices: [{ message: { content: '' } }] });
    const openaiProvider = makeOpenAIProvider(
      { chat: { completions: { create: createOpenAI } } } as OpenAILike,
      'gpt-x',
    );
    await openaiProvider.call(
      TRIAGE_SYSTEM_PROMPT,
      [openaiProvider.userMsg('u')],
      openaiProvider.toolSpecs([]),
    );
    const openaiReq = createOpenAI.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(openaiReq.messages.find((m) => m.role === 'system')?.content).toContain(
      TRIAGE_SYSTEM_PROMPT,
    );
  });
});

describe('OpenAI provider temperature', () => {
  async function requestFor(model: string): Promise<Record<string, unknown>> {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: '' } }] });
    const provider = makeOpenAIProvider({ chat: { completions: { create } } } as OpenAILike, model);
    await provider.call('system', [provider.userMsg('user')], provider.toolSpecs([]));
    return create.mock.calls[0]![0] as Record<string, unknown>;
  }

  test('sends temperature 0 for a chat model that accepts it', async () => {
    expect((await requestFor('gpt-4o')).temperature).toBe(0);
  });

  test('omits temperature for reasoning models that reject it', async () => {
    expect('temperature' in (await requestFor('o3-mini'))).toBe(false);
    expect('temperature' in (await requestFor('gpt-5'))).toBe(false);
  });
});

describe('evidence block sizing', () => {
  const item = {
    id: 'evidence-1',
    tool: 'query_metrics',
    input: { query: 'error_rate', window: '1h' },
    output: {
      series: [
        {
          metric: 'error_rate',
          points: [
            { t: 1, v: 0.2 },
            { t: 2, v: 0.4 },
          ],
        },
      ],
    },
    createdAt: new Date('2026-08-31T01:00:00.000Z'),
  };

  test('measures exactly what the renderer emits, separator included', () => {
    // The whole point of injecting this into loadIncidentEvidence is that it tracks the renderer.
    // Asserting the identity is what stops the two drifting apart in a later edit.
    expect(measureEvidenceBlock(item)).toBe(
      renderEvidenceBlock(item).length + EVIDENCE_BLOCK_SEPARATOR.length,
    );
  });

  test('sizes larger than compact JSON, which is the reason the option exists', () => {
    // The old budget counted JSON.stringify(output). The prompt spends the rendered block, which
    // carries a provenance header and a line-per-field payload, so budgeting in JSON let the real
    // prompt overrun its nominal cap.
    expect(measureEvidenceBlock(item)).toBeGreaterThan(JSON.stringify(item.output).length);
  });

  test('the render sits a fixed 61 chars above the sum of the charges, at any block count', () => {
    // measureEvidenceBlock's JSDoc documents this constant. Nothing else pins it, so a reworded
    // renderEvidence preamble would silently turn that doc into a false claim about the budget.
    const overheadFor = (count: number): number => {
      const items = Array.from({ length: count }, (_, i) => ({ ...item, id: `evidence-${i}` }));
      const charged = items.reduce((sum, each) => sum + measureEvidenceBlock(each), 0);
      return renderEvidence(items).length - charged;
    };
    expect(overheadFor(1)).toBe(61);
    // Independence from block count is the half of the claim a per-block error would break.
    expect(overheadFor(5)).toBe(61);
  });

  test('renderEvidence joins the same blocks the measure sized', () => {
    const rendered = renderEvidence([item, { ...item, id: 'evidence-2' }]);
    expect(rendered).toContain(renderEvidenceBlock(item));
    expect(rendered).toContain(
      EVIDENCE_BLOCK_SEPARATOR + renderEvidenceBlock({ ...item, id: 'evidence-2' }),
    );
  });
});

describe('evidence budget wiring', () => {
  // Behavioural tests cannot see this: every caller passing the DEFAULT measure still returns
  // evidence, just budgeted in the wrong unit, so dropping `measure` from a call site leaves the
  // suite green and silently reverts half of. Scanning the source is what makes the omission
  // fail. Same rationale as the importer guard in toon-encoding.test.ts.
  const SRC_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__') continue;
        out.push(...sourceFiles(full));
      } else if (entry.endsWith('.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  test('the only loadIncidentEvidence call site budgets in the rendered unit', () => {
    const callers = sourceFiles(SRC_DIR)
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      // Word-boundary matched, so the `reloadIncidentEvidence(` seam callers below, which contain
      // this name as a substring, are not miscounted as direct callers of the repository.
      .filter(({ text }) => /\bloadIncidentEvidence\(/.test(text));

    // One caller, not four. The handlers used to repeat the budget and the renderer at each reload,
    // where any one of them could drop the option; they now share a seam, so this pins that the
    // seam stays sole. A zero-length scan would pass every assertion below vacuously.
    expect(callers.map(({ file }) => relative(SRC_DIR, file)).sort()).toEqual([
      'worker/evidence.ts',
    ]);

    for (const { file, text } of callers) {
      const label = relative(SRC_DIR, file);
      // Every occurrence, not just the first: a second call site added to a file would otherwise
      // never be inspected and could drop the option while this stayed green.
      const sites = [...text.matchAll(/\bloadIncidentEvidence\(/g)];
      expect(sites.length, `${label}: expected at least one call site`).toBeGreaterThan(0);

      for (const site of sites) {
        const rest = text.slice(site.index);
        const end = rest.indexOf('});');
        // -1 would silently widen the window to the rest of the file and let unrelated text satisfy
        // the assertion below.
        expect(end, `${label}: call site has no '});' terminator`).toBeGreaterThan(0);
        expect(rest.slice(0, end), label).toContain('measure: measureEvidenceBlock');
      }
    }
  });

  test('the shortest rendered evidence block is the size the row ceiling assumes', () => {
    // The database package derives its row-ceiling floor from this number but cannot import the
    // renderer, so it restates it as a constant. Range over every payload shape that can reach the
    // renderer rather than measuring one: an empty object encodes to an empty document and is a
    // storable output, so a single scalar sample would pin 84 and claim a minimum that is really 83.
    const header = {
      id: '00000000-0000-4000-8000-000000000000',
      tool: 'a',
      input: {},
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const sizes = ([0, {}, [], '', null] as unknown[]).map((output) =>
      measureEvidenceBlock({ ...header, output }),
    );
    expect(Math.min(...sizes)).toBe(SHORTEST_EVIDENCE_BLOCK_CHARS);
  });

  test('every reload path reaches the store through that seam', () => {
    // The scan above only proves the seam is correct, not that anything uses it. Without this, a
    // handler could reload evidence through some other unbudgeted path and both tests stay green.
    const users = sourceFiles(SRC_DIR)
      .filter((file) => /\breloadIncidentEvidence\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_DIR, file))
      .sort();
    // Derived and exact, not a hand-written list checked with toContain: a hand-written list cannot
    // see a fifth reload path, and toContain over a whole file is satisfied by a call in a comment
    // or a dead branch. evidence.ts declares the seam; the four handlers call it.
    expect(users).toEqual([
      'worker/evidence.ts',
      'worker/reassessment.ts',
      'worker/recovery.ts',
      'worker/relation-reassessment.ts',
      'worker/resume.ts',
    ]);
  });
});
