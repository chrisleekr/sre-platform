import { describe, expect, test } from 'vitest';

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDefaults } from '../../packages/platform-settings/src/schema';

/* eslint-disable no-useless-concat -- every needle below is split so this file can never appear in its own sweeps. */

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

// Directories that hold no tracked source: build output, caches, dependencies, and the docs site.
const UNTRACKED_DIRS = new Set([
  '.git',
  '.turbo',
  '.vitest',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'site',
  '.venv',
]);

/** Every file under `dir`, relative to the project root, skipping the directories above. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (UNTRACKED_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      out.push(relative(projectRoot, join(dir, entry.name)));
    }
  }
  return out;
}

// Tracked files only, so an untracked scratch file in a working tree never decides this suite.
// The CI test image ships no git binary, and there a fresh clone holds nothing but tracked files,
// so the directory walk below is equivalent there and the guard runs in both places.
const trackedFiles = (() => {
  try {
    return execFileSync('git', ['ls-files', '-z'], {
      cwd: projectRoot,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString('utf8')
      .split('\0')
      .filter((path) => path !== '');
  } catch {
    return walk(projectRoot);
  }
})();

// Committed assets no sweep below can match. Every one of these formats carries NUL bytes, so the
// check inside the pass already dropped them, after paying to read and buffer 23MB of screenshot.
const BINARY_ASSET = /\.(?:png|jpe?g|gif|webp|ico|woff2?|pdf)$/i;

// Each needle is concatenated so this file is never its own offender.
const DECISION_DIRECTORY = 'architecture/' + 'decisions';
const DECISION_CITATION = new RegExp('ADR' + '-[0-9]+');
const VERIFY_SCRIPTS = ['verify-' + 'inbound.ts', 'verify-' + 'setup.ts'];
const RETIRED_WIKI_LINK = /https?:\/\/[^\s)]+\/-\/wikis/;

/**
 * Every text sweep this suite runs, so one pass answers all of them. Running a pass per sweep read
 * and decoded all 2066 tracked files six times over, which cost 10.8s a pass on a CI runner and
 * timed the first sweep out at vitest's 5s default.
 */
const SWEEPS: readonly { name: string; hit: (text: string) => boolean }[] = [
  { name: DECISION_DIRECTORY, hit: (text) => text.includes(DECISION_DIRECTORY) },
  { name: 'decision citation', hit: (text) => DECISION_CITATION.test(text) },
  ...VERIFY_SCRIPTS.map((basename) => ({
    name: basename,
    hit: (text: string) => text.includes(basename),
  })),
  { name: 'retired wiki link', hit: (text) => RETIRED_WIKI_LINK.test(text) },
];

/**
 * Offending paths per sweep, from a single pass over the tracked files. Each file is read and
 * dropped inside the loop, so peak retention is one file's text: the backend project runs serially
 * and this suite's allocation would otherwise stack with every suite around it. An unreadable path
 * or one that turns out to hold NUL bytes drops the entry rather than failing a sweep.
 *
 * The pass runs at module scope, so the cost lands on collection and no single test carries it.
 */
const offendersBySweep = ((): Map<string, string[]> => {
  const offenders = new Map(SWEEPS.map((sweep) => [sweep.name, [] as string[]]));
  for (const path of trackedFiles) {
    if (BINARY_ASSET.test(path)) continue;
    let buffer: Buffer;
    try {
      buffer = readFileSync(join(projectRoot, path));
    } catch {
      continue;
    }
    if (buffer.includes(0)) continue;
    const text = buffer.toString('utf8');
    for (const sweep of SWEEPS) {
      if (sweep.hit(text)) offenders.get(sweep.name)?.push(path);
    }
  }
  return offenders;
})();

/** Throws rather than reporting a clean sweep for a name no pass ever ran. */
function offendersOf(name: string): string[] {
  const offenders = offendersBySweep.get(name);
  if (offenders === undefined) throw new Error(`no sweep named ${name}`);
  return offenders;
}

/**
 * Minimal KEY=VALUE reader for .env.example. The apps load the real file through Bun's dotenv
 * reader, which expands `$VAR` unless escaped as `\$` and accepts backtick-quoted values. This
 * reader models neither, and a silent divergence would let the guard pass on a file the runtime
 * rejects, so it refuses any construct it cannot reproduce instead of guessing.
 */
function parseEnvFile(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (value.startsWith('`')) {
      throw new Error(
        `${key}: backtick-quoted value in .env.example; this reader models only quote characters`,
      );
    }
    if (/(?:^|[^\\])\$/.test(value)) {
      throw new Error(
        `${key}: unescaped $ in .env.example; Bun expands it as a variable, this reader does not`,
      );
    }
    parsed[key] = value.replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
  return parsed;
}

describe('repository hygiene', () => {
  test('carries no architecture decision directory or references to it', () => {
    expect(existsSync(join(projectRoot, 'architecture'))).toBe(false);

    expect(offendersOf(DECISION_DIRECTORY)).toEqual([]);
  });

  test('cites no decision records anywhere in tracked files', () => {
    const offenders = offendersOf('decision citation');

    expect(offenders, `decision citations remain in:\n${offenders.join('\n')}`).toEqual([]);
  });

  test('drops the unused connector verification scripts', () => {
    for (const basename of VERIFY_SCRIPTS) {
      const path = join(projectRoot, 'scripts/connectors', basename);
      expect(existsSync(path), `${path} still exists`).toBe(false);

      const referrers = offendersOf(basename);
      expect(referrers, `${basename} is still referenced by:\n${referrers.join('\n')}`).toEqual([]);
    }
  });

  test('keeps every test in a file the runner can collect', () => {
    // A test file the runner cannot collect is not a test. vitest.config.ts includes only
    // {ts,tsx,js,jsx}, and scripts/test-ci.sh and scripts/check-test-layout.sh build from the same
    // extension set, so any other module extension is invisible to the run, the file-set check and
    // the layout check alike. The bug is not specific to scripts/ or to .mjs, so neither is this.
    const invisible = trackedFiles.filter((path) =>
      /^(apps|packages|scripts)\/.*\.(test|spec)\.(mjs|cjs|mts|cts)$/.test(path),
    );
    expect(invisible, `uncollectable test files:\n${invisible.join('\n')}`).toEqual([]);

    expect(
      existsSync(join(projectRoot, 'scripts/alertmanager-slack-live/__tests__/cleanup.test.js')),
    ).toBe(true);
  });

  test('ships an .env.example that boots the platform settings defaults', () => {
    const envExample = readFileSync(join(projectRoot, '.env.example'), 'utf8');
    const parsed = parseEnvFile(envExample);

    // Defined-but-empty SMTP_* keys are not "unset": smtpDefault only disables SMTP when every key
    // is undefined, so blank placeholder lines make loadDefaults throw.
    expect(() => loadDefaults(parsed)).not.toThrow();

    // Regression guard against committing a usable master key. required() in packages/db/src/env.ts
    // rejects an empty value, which is the failure a developer should get.
    expect(Object.hasOwn(parsed, 'SECRETS_MASTER_KEY')).toBe(true);
    expect(parsed['SECRETS_MASTER_KEY']).toBe('');
    expect(envExample).toContain('openssl rand -base64 32');
  });

  test('resolves every relative link in the charter and readme documents', () => {
    const documents = ['README.md', 'CLAUDE.md', 'CONTEXT.md', 'CONTRIBUTING.md'];
    const broken: string[] = [];

    for (const document of documents) {
      const path = join(projectRoot, document);
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1];
        if (target === undefined) continue;
        if (target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const [relative] = target.split('#');
        if (relative === undefined || relative === '') continue;
        if (!existsSync(resolve(dirname(path), relative))) broken.push(`${document} -> ${target}`);
      }
    }

    expect(broken, `unresolved links:\n${broken.join('\n')}`).toEqual([]);
  });

  test('shows the dashboard in the readme', () => {
    expect(readFileSync(join(projectRoot, 'README.md'), 'utf8')).toContain(
      'docs/assets/screenshots/overview-dark.png',
    );
  });

  test('links to no retired wiki page', () => {
    // The wiki is disabled, so any such link is dead. Re-homed from the decision-record suite.
    const offenders = offendersOf('retired wiki link');

    expect(offenders, `retired wiki links in:\n${offenders.join('\n')}`).toEqual([]);
  });
});
