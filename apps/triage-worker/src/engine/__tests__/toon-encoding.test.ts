// Guards on the model-facing TOON encoding, for. Five of them:
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
// It scans src/ and skips __tests__, so the direct library import below is deliberately in scope of
// nothing: characterising the library needs options that MODEL_TOON_OPTIONS must never carry.
//
// C1 (seam) and -C2 (library) are the pair that keeps keyFolding off. C1 pins both halves
// of MODEL_TOON_OPTIONS, the encoder's keyFolding and the decoder's expandPaths, because the one
// constant feeds both and only one of the two flags is visible in encoder output. C2 records the
// library behaviour that is the reason to keep it off, so a future version that fixes that
// behaviour fails C2 and forces to be re-decided rather than left off by inertia.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decode, encode } from '@toon-format/toon';
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

// The options proposed, spelled out here and nowhere near production. The library documents
// them as a lossless pair; C2 is the counter-example to that claim.
const FOLDING_ENCODE = { indent: 2, keyFolding: 'safe' } as const;
const EXPANDING_DECODE = { indent: 2, expandPaths: 'safe' } as const;

describe('model-facing TOON key folding', () => {
  test('C1 MODEL_TOON_OPTIONS neither folds a key chain nor expands a dotted key', () => {
    // The seam half. Enabling keyFolding on MODEL_TOON_OPTIONS collapses this chain to the single
    // line `a.b.c: 1` and fails here. Which guard catches which mutation:
    //   keyFolding ALONE on the constant: caught here, and also by C2 below, because decodeFromModel
    //   then receives keyFolding, which the decoder ignores, instead of expandPaths, so the
    //   fixture's `state: { running: { startedAt } }` chains come back as literal dotted keys and
    //   fail toEqual.
    //   the documented pair, keyFolding plus expandPaths: caught ONLY here. The round trip recovers
    //   the input and stays green.
    // The round trip's blindness to the pair is corpus-dependent, not structural: no fixture
    // carries a literal dotted key whose segments are all identifiers, every dotted key in them has
    // a "/" (see -C2), and one that did would turn -C2 red. Unquoted alone is not enough:
    // isValidUnquotedKey allows dots inside a segment, isIdentifierSegment does not, so `a.2b` is
    // emitted unquoted and still never expanded. Its blindness to width IS structural, because the
    // decoder derives depth arithmetically and agrees with the encoder at any width.
    //
    // Asserted on the TRIMMED lines, so the failure can only mean folding. Indentation is -C1's
    // subject, and an assertion carrying the raw columns would also break on a width change and
    // blame it on this flag.
    const lines = encodeForModel({ a: { b: { c: 1 } } })
      .split('\n')
      .map((line) => line.trim());
    expect(lines).toEqual(['a:', 'b:', 'c: 1']);

    // The decode half of the same constant. expandPaths is decode-only, so adding it to
    // MODEL_TOON_OPTIONS without keyFolding is invisible to the encoder assertion above, and
    // C2 misses it too because no fixture carries a dotted key whose segments are all
    // identifiers. This is the line that goes red: at expandPaths: 'safe' the literal key is read
    // back as a path and nests.
    expect(decodeFromModel('app.kubernetes.io: api')).toEqual({ 'app.kubernetes.io': 'api' });
  });

  test('C2 folding is ambiguous because a literal dotted key is emitted unquoted', () => {
    // The library half, and the reason C1 exists rather than a bare preference. `keyFolding: 'safe'`
    // is only safe if its inverse can tell a folded path from a key that always had dots in it, and
    // in @toon-format/toon 2.3.1 it cannot: the encoder does not quote a dotted key whose segments
    // are all identifiers, so `expandPaths: 'safe'` reverses a key the author never nested.
    //
    // Asserted positively on the corrupted and throwing outcomes, not as "decoded !== input": a
    // future version that fixes the quoting would still satisfy an inequality on some shapes, and
    // this guard has to go red when the fix lands so gets re-decided instead of staying off by
    // default. Measured savings if it were ever safe: -1.20% of encodeForModel characters over the
    // six TOON_ENCODING_SAMPLES.
    const dotted = encode({ 'app.kubernetes.io': 'api' }, FOLDING_ENCODE);
    expect(dotted).toBe('app.kubernetes.io: api');
    expect(decode(dotted, EXPANDING_DECODE)).toEqual({ app: { kubernetes: { io: 'api' } } });

    // Silent corruption is the common case above. A literal key that collides with a real folded
    // path is the loud one, and it surfaces as a decode-time throw rather than a bad value. The
    // throw is gated on the decoder's `strict`, which only DEFAULTS to true (EXPANDING_DECODE
    // leaves it unset): at `strict: false` this same input silently overwrites, last write wins, to
    // `{ x: { a: 9 } }` with the `{ b: 1 }` subtree destroyed. The loud case is a property of the
    // default, not of the collision.
    const colliding = encode({ x: { a: { b: 1 } }, 'x.a': 9 }, FOLDING_ENCODE);
    expect(colliding).toBe('x.a.b: 1\nx.a: 9');
    expect(() => decode(colliding, EXPANDING_DECODE)).toThrow(/Path expansion conflict/);

    // Why read as intermittent rather than payload-dependent: a real k8s label key carries a
    // "/", which forces quoting, so a sample full of them survives folding by accident.
    expect(encode({ 'app.kubernetes.io/name': 'api' }, FOLDING_ENCODE)).toBe(
      '"app.kubernetes.io/name": api',
    );
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
