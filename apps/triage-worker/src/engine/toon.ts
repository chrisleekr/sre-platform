import { decode, encode } from '@toon-format/toon';

// The sole owner of @toon-format/toon in the engine, so one constant fixes the width for both
// halves. Only encode has a production caller; decode is exported so the round-trip test can prove
// the encoder is lossless at this width. Nothing in production decodes model-facing TOON today.
//
// Library citations below name symbols, never dist line offsets: a bundled line number moves on a
// patch release, and 2.3.1 inserted a whole region that shifted every symbol below it, decoder
// symbols included. Every percentage this file asserts is characters of encodeForModel output over
// the six TOON_ENCODING_SAMPLES in __tests__/toon-encoding.fixture.ts.
//
// The width is part of the parse, not formatting, and a mismatch announces itself only under the
// decoder's strict: the decoder derives depth as floor(indentSpaces / indentSize), so text written
// at 2 and read at 1 decodes to a doubled depth. Arrays then throw on their row/item count
// assertion, odd indents throw the multiple check, and an object-only payload throws the depth-jump
// check. All three are gated on strict, which decodeFromModel leaves unset and so defaults to true.
// At strict: false the array decodes silently to [] and the object decodes silently, because the
// object decoder adopts the first child line's depth. Verified against @toon-format/toon 4.1.1
// dist/index.mjs: computeDepthFromIndent (the floor division), parseLineIncremental (the strict
// multiple check), assertNoDepthJump (the strict depth-jump check), decodeObjectFields (the adopted
// depth), assertExpectedCount (the row and item counts).
//
// Width stays at the TOON spec default of 2. DECIDED, not pending an eval. The "- " list
// marker is exactly one indent unit wide: at 2 a list item's continuation fields align under its
// first field, and at 1 they land one column to its LEFT while a nested key lands in the first
// field's own column. List form is the dominant shape in recorded tool output (94% of encoded
// characters on the corpus), so that alignment is the common case. Narrowing to 1 measures
// -11.99% and was declined because the accuracy eval that would have justified it could not have
// decided it: paired over the 20-30 incidents proposed, a true 5-10pp regression yields 2-3
// discordant pairs, which is not separable from LLM sampling noise, so the likely null reads as a
// green light. The C1 test in __tests__/toon-encoding.test.ts keeps it honest.
//
// Keys are never folded: @toon-format/toon 4.0 removed key folding and path expansion, which this
// module had kept off because a literal dotted key and a folded path encode to the same line.
const MODEL_TOON_OPTIONS = { indentSize: 2 } as const;

/** Encode a value as the TOON the model reads. */
export function encodeForModel(value: unknown): string {
  return encode(value, MODEL_TOON_OPTIONS);
}

/** Decode TOON produced by `encodeForModel` back to its JSON data model. */
export function decodeFromModel(text: string): unknown {
  return decode(text, MODEL_TOON_OPTIONS);
}
