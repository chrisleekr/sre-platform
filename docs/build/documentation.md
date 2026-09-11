# Keeping the docs true

Documentation rots when it repeats something the code already knows. This guide is built to reduce
how much of it can rot, and to fail the build when the rest does.

Four mechanisms, in order of how much they cover.

## 1. Derive rather than describe

Anything the source already knows is generated from the source, not typed twice. Today that is the
repository layout, the CI gate list, the platform settings table, the dashboard menu, and every
connector's tool inventory.

The connector tool tables are the clearest case. The generator calls each connector's real factory
and reads back the tools it registers, so a tool that is added, renamed, or removed changes the
published table with no page edit. `bun run docs:gen --check` is a CI gate: a committed block that
no longer matches its source fails the build.

What cannot be derived is judgement. What a workspace is *for*, what a gate is *protecting*, what a
setting means in practice: that lives in a notes file keyed by the identity the generator
discovers. The pairing is deliberate, and it fails in both directions. A new workspace with no note
fails, and a note for a workspace that no longer exists fails too, so the table can never be half
written.

## 2. Screenshots are generated, never taken by hand

Every image in this guide is produced by one command. It boots its own throwaway PostgreSQL and
Valkey on random ports, applies the real migrations, seeds a demo tenant through the real code
paths, builds and serves the real dashboard, and drives it with a browser.

That matters for staleness because there is no manual step to skip. Nobody has to remember which
screens changed, or crop anything, or keep a private copy of the demo data.

It also cannot touch your development database. The harness passes its own connection details to
every child process and refuses to start if they match an inherited one.

A failed run leaves the published images alone. Capture writes to a staging directory and swaps it
in only after every shot has succeeded, so a broken run can never leave the guide referencing images
that no longer exist.

### The wizard walk checks itself against the product

The setup pages are the most drift-prone in the guide, because they describe a sequence of screens
step by step. So the capture walks every wizard for real, the Slack connection and each connector
alike: it fills each form, presses the button that advances, and photographs every step.

Before it starts, it reads the wizard's own progress bar and compares it to the step list the guide
claims. Rename a step, add one, or remove one, and the capture stops with both lists printed. It
cannot silently publish a guide that describes screens the product no longer has.

Because each image is named after its step, a renamed step also renames its file, and the strict
build below then fails on the page that still points at the old name. The two checks catch the same
drift from opposite ends.

## 3. The strict build refuses broken references

`mkdocs build --strict` fails on a broken internal link, a missing image, or a page absent from the
navigation. Any of those is an error, not a warning.

## 4. Prose rules are enforced, not requested

`bun run docs:lint` fails on em dashes, tracker and decision-record references, and source paths.
The source-path rule exists because a reader of the user guide has no checkout. Pages under
**Build** are exempt from that one rule, because their subject is the code, and every other rule
still applies to them.

## What is still maintained by hand

Being honest about the remaining gap is more useful than claiming full coverage.

| Still by hand | What protects it |
| --- | --- |
| Every explanatory sentence | Nothing automatic. Prose is the part worth writing by hand |
| Which screenshot a page embeds | The strict build, which fails if the file is missing |
| Step-by-step explanations of each wizard screen | The step-name assertion, which fails if the sequence changes |
| Counts stated in prose, such as how many connectors exist | Nothing automatic |

The last row is a real gap. A count in a sentence is exactly the kind of fact that should be
derived, and it is a good candidate for the next thing to generate.

## Working on the docs

```
bun run docs:install    # once
bun run docs:serve      # live preview
bun run docs:gen        # regenerate derived blocks after a source change
bun run docs:build      # what CI runs
```

Screenshots are regenerated with `bun scripts/docs/screenshots/capture.ts`. It needs a Docker
daemon and a browser from `bunx playwright install chromium`. Run it directly rather than through
the package script, which buffers output and hides progress.
