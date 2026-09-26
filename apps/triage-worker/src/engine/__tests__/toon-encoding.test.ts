// Guards on the model-facing TOON encoding. Three of them:
//
// C1 (alignment) exists because the obvious token saving here is narrowing the indent, and a
// round-trip test cannot refuse it: the decoder derives depth arithmetically, so encode and decode
// agree at ANY width while the text the model reads becomes misaligned. C1 asserts the property the
// round trip cannot, measured on the PRODUCTION seam (renderModelToolResult) rather than a bare
// `encode` constant.
//
// C2 (round trip) proves the encoder is lossless at this width. Necessary, never sufficient.
//
// C3 (ownership) asserts that engine/toon.ts is the ONLY non-test module in the app allowed to
// reach for @toon-format/toon. An exact-array assertion (never toContain) is what makes it a drift
// guard: a future seam that imports the encoder directly, and silently picks its own width, fails.
// It scans src/ and skips __tests__.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { decodeFromModel, encodeForModel } from '../toon';
import { renderModelToolResult } from '../tool-result';
import { TOON_ENCODING_SAMPLES } from './toon-encoding.fixture';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC_DIR = resolve(HERE, '..', '..');

// Large enough that renderModelToolResult never takes its truncation branch: these assertions are
// about layout, not the cap. The `outcome === 'complete'` check below is the backstop.
const HUGE_MAX_CHARACTERS = 1_000_000;

const LIST_ITEM = /^(\s*)- \S/;

/**
 * Every line of a list item that is not itself a new item and has not dedented out of the item.
 * Returns the leading-space count of each, which is what encodes depth to the reader.
 */
function continuationIndents(lines: string[], index: number, itemIndent: number): number[] {
  const out: number[] = [];
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= itemIndent) break;
    // A nested list item is still a descendant of this one, and its own hyphen line sits at
    // itemIndent + 2 or deeper, so it satisfies the same assertion. Skipping it instead of
    // stopping keeps the outer item's fields that FOLLOW a nested array in scope.
    if (LIST_ITEM.test(line)) continue;
    out.push(indent);
  }
  return out;
}

describe('model-facing TOON encoding', () => {
  test('C1 list-item fields stay aligned with the first field, never left of it', () => {
    // The "- " marker is exactly one indent unit wide at the spec default of 2, which is what makes
    // a list item's continuation fields land in the same column as the field on the hyphen line. At
    // width 1 they land one column LEFT of it and a nested key lands in the first field's column,
    // so the text stops encoding depth by position. List form is the dominant shape in recorded
    // tool output (94% of encoded characters on the corpus) and no accuracy eval backs
    // narrowing it. Narrowing is tracked as.
    //
    // Counted per sample, not in aggregate: an array of PRIMITIVES encodes to a `- ` item with no
    // continuation lines at all, so counting items would let a corpus of those pass while the
    // assertion below never ran once. Requiring every sample to contribute also keeps all six
    // earning their place instead of one carrying the file.
    const alignedFieldsBySample = new Map<string, number>();

    for (const sample of TOON_ENCODING_SAMPLES) {
      const rendered = renderModelToolResult(
        sample.tool,
        { available: true, evidenceId: sample.evidenceId, data: sample.data },
        HUGE_MAX_CHARACTERS,
      );
      expect(rendered.receipt.outcome).toBe('complete');
      expect(rendered.isError).toBe(false);

      const lines = rendered.content.split('\n');
      for (const [index, line] of lines.entries()) {
        const match = LIST_ITEM.exec(line);
        if (!match) continue;
        const itemIndent = match[1]!.length;
        // The first field sits after the "- " marker.
        const firstFieldColumn = itemIndent + 2;

        const indents = continuationIndents(lines, index, itemIndent);
        for (const indent of indents) {
          expect(
            indent,
            `${sample.tool}: continuation at column ${indent} is left of the first field at ${firstFieldColumn}`,
          ).toBeGreaterThanOrEqual(firstFieldColumn);
        }
        alignedFieldsBySample.set(
          sample.tool,
          (alignedFieldsBySample.get(sample.tool) ?? 0) + indents.length,
        );
      }
    }

    for (const sample of TOON_ENCODING_SAMPLES) {
      expect(
        alignedFieldsBySample.get(sample.tool) ?? 0,
        `${sample.tool} contributed no list-item continuation fields, so it asserted nothing`,
      ).toBeGreaterThan(0);
    }
  });

  test('C2 the encoding is a lossless round-trip for every recorded shape', () => {
    // Necessary but NOT sufficient on its own: the decoder recovers structure at any width, which
    // is exactly why C1 has to assert the rendered layout separately.
    for (const sample of TOON_ENCODING_SAMPLES) {
      const value = { evidenceId: sample.evidenceId, data: sample.data };
      expect(decodeFromModel(encodeForModel(value))).toEqual(value);
    }
  });

  test('C3 engine/toon.ts is the only non-test module in the app importing @toon-format/toon', () => {
    // Scanned from src/, not src/engine/: @toon-format/toon is a dependency of the whole
    // apps/triage-worker package, so an importer under worker/ would pick its own width while an
    // engine-only scan stayed green.
    const importers = appSourceFiles(SRC_DIR)
      .filter((file) => readFileSync(file, 'utf8').includes('@toon-format/toon'))
      .map((file) => relative(SRC_DIR, file))
      .sort();

    // Exact, not toContain: an extra direct importer is precisely the drift this guards against.
    expect(importers).toEqual(['engine/toon.ts']);
  });
});

function appSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      out.push(...appSourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}
