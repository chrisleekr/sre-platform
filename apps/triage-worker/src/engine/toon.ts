import { decode, encode } from '@toon-format/toon';

// The sole owner of @toon-format/toon in the engine, so one constant fixes the width for both
// halves. Only encode has a production caller; decode is exported so the round-trip test can prove
// the encoder is lossless at this width. Nothing in production decodes model-facing TOON today.
//
// Library citations below name symbols, never dist line offsets: a bundled line number moves on a
// patch release, and 2.3.1 inserted a whole region that shifted every symbol below it, decoder
// symbols included. Every percentage this file asserts is characters of encodeForModel output over
// the six TOON_ENCODING_SAMPLES in __tests__/toon-encoding.fixture.ts. The one quoted figure that
// is not, 's -4.7%, is named as a quoted exception below.
//
// The width is part of the parse, not formatting, and a mismatch does NOT reliably announce itself:
// the decoder derives depth as floor(indentSpaces / indent), so text written at 2 and read at 1
// decodes to a doubled depth. Arrays then throw on their row/item count assertion and odd indents
// throw the multiple check, but both are gated on the decoder's strict, which decodeFromModel
// leaves unset and so defaults to true; at strict: false the array decodes silently to []. An
// object-only payload decodes SILENTLY at either setting, because the object decoder adopts the
// first child line's depth. Verified against @toon-format/toon 2.3.1
// dist/index.mjs: computeDepthFromIndent (the floor division), parseLineIncremental (the strict
// multiple check), decodeObjectFieldsSync (the adopted depth), assertExpectedCount (the row and
// item counts).
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
// keyFolding stays off. DECIDED. Worth -1.20% at width 2 and -0.73% at width 1: what folding
// removes is the unfolded form's per-line indent, so it saves LESS at the narrower width and no
// choice of baseline turns 1.20% into the -4.7% that proposal quoted. That -4.7% does not reproduce
// here at either baseline and stays UNEXPLAINED. measured every recorded
// agent_tool_calls.output row in the dev corpus, roughly 4,269 rows, against six samples here, so a
// different corpus or a different counting unit is the likely difference, but neither has been
// shown to produce the number.
//
// Declined because the fold is not reversible here: the encoder does not quote a literal dotted key
// whose segments are all identifiers, so expandPaths: 'safe' reads that key as a fold and nests it,
// or throws when it collides with a real folded path. That throw is gated on the decoder's strict,
// which only DEFAULTS to true; at strict: false the colliding key silently overwrites, last write
// wins, and the nested value it landed on is lost, so a reader re-checking this at strict: false
// sees corruption where the record says throw. The model reading the same line cannot tell a fold
// from a literal either. rootLiteralKeys is not a defence: it is collected at depth 0 only and
// merely blocks folding INTO a colliding path, never quotes the literal key. Verified against 2.3.1 dist/index.mjs: encodeKey via isValidUnquotedKey (dots are
// legal in an unquoted key), isIdentifierSegment and expandPathsSafe (the same dots read back as a
// path), insertPathSafe (the strict-gated conflict throw), tryFoldKeyChain and its rootLiteralKeys
// argument, collected in encodeObjectLines at depth 0. The C1 and C2 tests in
// __tests__/toon-encoding.test.ts keep it off.
const MODEL_TOON_OPTIONS = { indent: 2 } as const;

/** Encode a value as the TOON the model reads. */
export function encodeForModel(value: unknown): string {
  return encode(value, MODEL_TOON_OPTIONS);
}

/** Decode TOON produced by `encodeForModel` back to its JSON data model. */
export function decodeFromModel(text: string): unknown {
  return decode(text, MODEL_TOON_OPTIONS);
}
