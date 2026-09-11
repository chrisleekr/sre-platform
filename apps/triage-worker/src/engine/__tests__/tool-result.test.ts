import { describe, expect, test } from 'vitest';
import { encodeForModel } from '../toon';
import { renderModelToolResult, toolResultMaxChars } from '../tool-result';

describe('renderModelToolResult', () => {
  test('keeps complete data unchanged when it fits', () => {
    const result = renderModelToolResult(
      'metrics',
      {
        available: true,
        evidenceId: '11111111-1111-4111-8111-111111111111',
        data: { value: 42 },
      },
      6_000,
    );
    expect(result.content).toContain('value: 42');
    expect(result.receipt.outcome).toBe('complete');
  });

  test('marks an oversized result as partial instead of silently cutting it', () => {
    const result = renderModelToolResult(
      'logs',
      {
        available: true,
        evidenceId: '11111111-1111-4111-8111-111111111111',
        data: { lines: 'x'.repeat(10_000) },
      },
      600,
    );
    expect(result.content.length).toBeLessThanOrEqual(600);
    expect(result.content).toContain('completeness: truncated');
    expect(result.content).toContain('narrow the query');
    expect(result.receipt.outcome).toBe('partial');
  });

  test('C7 reports the TRUE encoded total on a truncated result, not the emitted length', () => {
    // The model narrows its query off this number, so it must describe the whole payload it did not
    // receive. Measuring it in the same encoding the seam emits keeps that honest.
    const evidenceId = '11111111-1111-4111-8111-111111111111';
    const data = { rows: Array.from({ length: 200 }, (_, i) => ({ i, level: 'error', msg: 'x' })) };
    const result = renderModelToolResult('logs', { available: true, evidenceId, data }, 600);

    expect(result.receipt.outcome).toBe('partial');
    const expected = encodeForModel({ evidenceId, data }).length;
    expect(result.content).toContain(`totalCharacters: ${expected}`);
  });

  test('records a safe unavailable receipt without exposing an error', () => {
    const result = renderModelToolResult(
      'logs',
      {
        available: false,
        reason: 'error',
        evidenceId: '11111111-1111-4111-8111-111111111111',
      },
      600,
    );
    expect(result.content).toBe(
      'error: tool failed; evidenceId: 11111111-1111-4111-8111-111111111111',
    );
    expect(result.receipt.outcome).toBe('unavailable');
  });
});

describe('the tool-result cap has one owner', () => {
  test('both engine runtimes read the cap from this module, not their own constant', async () => {
    // A source scan, not a value comparison: two independently defined constants that happen to
    // agree would pass any assertion on the number. What must hold is that neither runtime can
    // define its own, since a divergence would change what one engine shows the model and not the
    // other, silently.
    const { readFile } = await import('node:fs/promises');
    const sources = ['../loop.ts', '../agent-sdk/tools.ts'];
    for (const relative of sources) {
      const source = await readFile(new URL(relative, import.meta.url), 'utf8');
      // The NAMED import, not just the module path: both runtimes already imported
      // renderModelToolResult from here before the cap moved, so a path-only match was true of the
      // very code this guards against and could never fail for it.
      expect(source).toMatch(
        /import\s*\{[^}]*\btoolResultMaxChars\b[^}]*\}\s*from\s*'\.{1,2}\/tool-result'/,
      );
      expect(source).toMatch(/\btoolResultMaxChars\(\)/);
      // Any identifier CONTAINING the stem. `\b` is wrong here: `_` is a word character, so there
      // is no boundary inside DEFAULT_TOOL_RESULT_MAX and a boundary-anchored pattern silently
      // misses the loop.ts spelling, which is one of the two duplicates this exists to catch.
      expect(source).not.toMatch(/\w*TOOL_RESULT_MAX\w*\s*=[^=]/);
      expect(source).not.toMatch(/process\.env\.TOOL_RESULT_MAX_CHARS/);
    }
  });

  test('a non-numeric or non-positive override falls back instead of yielding NaN', () => {
    const original = process.env.TOOL_RESULT_MAX_CHARS;
    try {
      // NaN would make `encoded.length <= max` false for every payload, sending complete results
      // down the truncation branch. Zero and a negative would truncate everything to nothing.
      for (const value of ['not-a-number', '0', '-1', '']) {
        process.env.TOOL_RESULT_MAX_CHARS = value;
        expect(toolResultMaxChars()).toBe(6000);
      }
      process.env.TOOL_RESULT_MAX_CHARS = '12000';
      expect(toolResultMaxChars()).toBe(12000);
    } finally {
      if (original === undefined) delete process.env.TOOL_RESULT_MAX_CHARS;
      else process.env.TOOL_RESULT_MAX_CHARS = original;
    }
  });
});
