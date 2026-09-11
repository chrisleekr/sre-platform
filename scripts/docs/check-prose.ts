#!/usr/bin/env bun
/**
 * Enforce the documentation prose rules that a reader notices.
 *
 * The user guide is written for people operating the platform, not for people changing it. Three
 * things repeatedly leaked in from engineering notes and are banned outright:
 *
 * - **Source locations.** A reader has no checkout. A file path, a directory, or an internal
 *   function name tells them nothing they can act on.
 * - **Tracker and decision links.** Issue numbers and ADR references point at private history a
 *   reader cannot open, and they date the page.
 * - **Em dashes.** House style. Use a comma, a colon, or a full stop.
 *
 * Run: `bun run docs:lint`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOCS = join(ROOT, 'docs');

interface Rule {
  name: string;
  pattern: RegExp;
  hint: string;
  /** Pages exempt from this rule, relative to `docs/`. */
  allow?: string[];
}

/**
 * Pages written for contributors rather than operators.
 *
 * The source-path ban exists because a reader of the user guide has no checkout. That reasoning
 * does not hold for a page whose whole subject is changing the code, so those pages, and only
 * those, may name real paths. Every other rule still applies to them.
 */
const CONTRIBUTOR_PAGES = [
  'build/connectors.md',
  'build/documentation.md',
  'build/index.md',
  'build/model-encoding.md',
];

const RULES: Rule[] = [
  {
    name: 'em dash',
    pattern: /—/g,
    hint: 'use a comma, a colon, or a full stop',
  },
  {
    name: 'issue reference',
    pattern: /(?<![\w&])#\d+\b/g,
    hint: 'describe the behaviour instead of citing a tracker item',
  },
  {
    name: 'ADR reference',
    pattern: /\bADR-\d+\b|\/wikis\/adr\//gi,
    hint: 'state the rule itself; user documentation must not depend on internal decision records',
  },
  {
    name: 'source path',
    pattern:
      /`[^`\n]*\b(?:apps|packages|scripts)\/[A-Za-z0-9_./*-]+[^`\n]*`|`[^`\n]*\.(?:ts|tsx)`/g,
    hint: 'describe what it does, not where it lives',
    allow: CONTRIBUTOR_PAGES,
  },
];

/** Collects every Markdown file under a directory, skipping generated partials. */
function markdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Generated partials are derived from source and are checked at their origin instead.
      if (entry !== '_generated') markdownFiles(full, out);
    } else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Character ranges covered by fenced code blocks, which are exempt from prose rules. */
function fencedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const fence = /^```[\s\S]*?^```/gm;
  for (const match of text.matchAll(fence))
    ranges.push([match.index!, match.index! + match[0].length]);
  return ranges;
}

let violations = 0;

for (const file of markdownFiles(DOCS).sort()) {
  const text = readFileSync(file, 'utf8');
  const exempt = fencedRanges(text);
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);

  const page = relative(DOCS, file);
  for (const rule of RULES) {
    if (rule.allow?.includes(page)) continue;
    for (const match of text.matchAll(rule.pattern)) {
      const at = match.index!;
      if (exempt.some(([start, stop]) => at >= start && at < stop)) continue;
      let line = 0;
      while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= at) line += 1;
      console.error(
        `${relative(ROOT, file)}:${line + 1}  ${rule.name}: ${match[0].trim()}  (${rule.hint})`,
      );
      violations += 1;
    }
  }
}

if (violations > 0) {
  console.error(`\n${violations} documentation prose violations.`);
  process.exitCode = 1;
} else {
  console.log('documentation prose is clean.');
}
