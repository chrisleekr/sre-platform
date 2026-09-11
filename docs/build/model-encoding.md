# The model-facing encoding contract

Everything the investigator reads from a tool, or reads back as prior evidence, is encoded as TOON
rather than JSON. TOON writes a uniform array as a header naming the columns followed by one
indented line per row, so the field names are paid for once instead of once per row. How much that
saves depends on the shape: a nested payload has more repeated field names to fold away, while a
flat uniform array is already close to a table and gains least.

This page exists because the encoding has one property that is easy to break by accident and
expensive to notice.

## Encode and decode travel together

`apps/triage-worker/src/engine/toon.ts` is the only module in the engine that imports the TOON
library. It exports a matched pair, `encodeForModel` and `decodeFromModel`, over a single options
constant. A test fails the build if any other module imports the library directly.

That is not tidiness. The indent width is part of the parse, not of the formatting, and a mismatch
does not reliably announce itself. The decoder recovers each line's depth by dividing its leading
spaces by the configured width, so text written at width 2 and read at width 1 decodes to double the
depth it was written with. An array then throws, because its declared row count no longer matches
what was read, and an odd indent throws the strict-multiple check. **An object-only payload decodes
silently and wrongly**, because the object decoder adopts whatever depth its first child line
appears to have.

So a bare `encode()` somewhere, or a decode with different options, produces text that round-trips
against itself and corrupts against the other half. Keeping both halves behind one constant is what
makes that unrepresentable.

## The width stays at 2

The TOON specification's default indent is 2, and narrowing it to 1 measures around a tenth fewer
characters across recorded tool output. It is still set to 2, deliberately.

The reason is the list marker. `- ` is exactly two characters, so at width 2 a list item's
continuation fields line up under the item's first field, and a nested key sits one level in from it:

```
indent 2                    indent 1
  - name: a                  - name: a
    phase: Running            phase: Running
      running:                 running:
```

At width 1 the continuation fields land one column to the **left** of the field they continue, and a
nested key lands in the first field's own column. Position stops encoding depth. List form accounts
for 94% of all encoded characters in recorded tool output, so this is the common shape, not an edge
case.

Round-trip fidelity does not settle the question either way: the decoder derives depth
arithmetically, so encode and decode agree at any width while the rendered text degrades. The model
never runs the decoder. It reads the text.

Narrowing the width is therefore a real saving that is not worth taking, and that is a decision, not
a pending measurement. The accuracy comparison that would have justified narrowing could not have
settled it: paired over the twenty to thirty incidents available, a genuine five to ten point
regression shows up as two or three discordant pairs, which is not separable from the model's own
sampling noise, so the likely null result would have been read as a green light.

Folding nested keys into dotted paths is off for a different reason, and it is worth less than it
sounds: about 1.2% of characters at width 2 and about 0.7% at width 1. What folding removes is the
per-line indent of the unfolded form, so it saves less at the narrower width, not more. It stays off
because the fold is not reversible. A key whose segments are all plain identifiers is written
without quotes whether its author nested it or not, so the reverse pass cannot tell a folded path
from a key that always had dots in it: it either nests a key nobody nested, or fails outright when
that key collides with a real folded path. Kubernetes label keys are the exception that hides this
rather than the reason for it. A real one carries a slash, which forces quoting, so the reverse pass
skips it and it survives folding untouched. The dangerous key is the dotted one with no slash.

## The per-result character cap

A single tool result is capped before it reaches the model, at 6000 characters by default and
tunable by environment. A substantial minority of real tool results sit exactly at that cap, so the
value is load-bearing rather than a formality.

Both engine runtimes render through one function, `renderModelToolResult` in
`apps/triage-worker/src/engine/tool-result.ts`, and the cap is defined beside it. When a payload
exceeds it, the result is not simply cut: the model receives a header stating that the payload is
truncated, its true length, and an instruction to narrow the query before concluding that something
is absent. A cut payload must never read as complete data.

## Reloaded evidence is bounded twice

Prior evidence reloaded into a resume or recovery prompt is bounded by a character budget, spent
newest-first, sized by the same renderer that produces the prompt so the budget is charged in the
unit the prompt actually costs. A line that would overflow the budget is skipped rather than ending
the loop, so one large recent output cannot evict every smaller older line behind it.

A second, coarser bound limits how many rows are read from the database at all. It exists to stop an
incident with thousands of tool calls from pulling an unbounded result set into a worker. Both bounds
are operator settings rather than deployment environment values, so neither needs a restart to
change and neither is pinned to what a container was started with.

The two bounds count different things and cannot be compared directly. The row bound counts raw rows
as stored; the character budget counts distinct lines after repeated runs of the same tool and input
have been collapsed into one. So a row bound numerically larger than any line count the budget could
pay for still guarantees nothing: if the rows read are mostly repeats, they collapse to fewer lines
than the budget had room for, and a tool result whose most recent run falls outside the window is
hidden with budget left unspent. Reaching the row bound is logged for that reason, together with how
many lines the budget could have paid for, so it is visible which of the two actually bit.
