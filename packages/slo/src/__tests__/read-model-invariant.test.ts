// The error budget is a read model, never an ingress. Budget state may enrich, rank, stamp and
// report; it may never open an incident. This is a source scan for the same reason the ingress
// invariant is one: a direct call is a design decision that needs explicit review and sign-off on
// the merge request, and it should fail at review time with a named file rather than at 3am.
//
// The narrow dependency set is what makes the scan trivially true: a package that cannot import the
// opener or the queue cannot call them, however the code is later refactored.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_ROOT = join(PACKAGE_ROOT, 'src');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '__tests__']);

/** Symbols that mint an Incident. None of them may be named anywhere in this package. */
const INGRESS_SYMBOLS = ['createIncident', 'openIncidentWorkspace', 'routeToIncident'];

/** Workspaces through which an ingress call could be reached. */
const FORBIDDEN_IMPORTS = ['@sre/alerts', '@sre/queue', '@sre/hub', '@sre/surfaces'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

const sources = walk(SRC_ROOT).map((file) => ({
  path: relative(PACKAGE_ROOT, file).split('\\').join('/'),
  text: readFileSync(file, 'utf8'),
}));

describe('the error budget is a read model, never an ingress', () => {
  // Guards the scan itself: an empty file list would make every assertion below pass vacuously.
  test('the scan sees the package production sources', () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.map((s) => s.path).sort()).toContain('src/index.ts');
  });

  for (const symbol of INGRESS_SYMBOLS) {
    test(`no module names ${symbol}`, () => {
      const offenders = sources
        .filter((s) => new RegExp(`\\b${symbol}\\b`).test(s.text))
        .map((s) => s.path)
        .sort();
      expect(offenders).toEqual([]);
    });
  }

  for (const dep of FORBIDDEN_IMPORTS) {
    test(`no module imports ${dep}`, () => {
      const offenders = sources
        .filter((s) => new RegExp(`from\\s+['"]${dep}(/[^'"]*)?['"]`).test(s.text))
        .map((s) => s.path)
        .sort();
      expect(offenders).toEqual([]);
    });
  }

  test('the package depends on the database workspace and nothing else', () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      name: string;
      dependencies?: Record<string, string>;
    };
    expect(pkg.name).toBe('@sre/slo');
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(['@sre/db']);
  });

  test('the fake SLI reader is not reachable from the package entrypoint', () => {
    // A fake reader answers with a number no query produced, and a reliability figure with no query
    // behind it is the one thing this subsystem must never show. It lives behind an explicit
    // test-support subpath so production code cannot reach it by importing the package.
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      exports?: Record<string, string>;
    };
    expect(pkg.exports).toEqual({
      '.': './src/index.ts',
      './test-support': './src/test-support.ts',
    });

    const entrypoint = readFileSync(join(SRC_ROOT, 'index.ts'), 'utf8');
    expect(entrypoint).not.toContain('test-support');

    // Nothing the entrypoint re-exports may name it either, so it cannot leak through a barrel file.
    const reachable = sources.filter(
      (s) => s.path !== 'src/test-support.ts' && /\bmakeFakeSliReader\b/.test(s.text),
    );
    expect(reachable.map((s) => s.path)).toEqual([]);
  });

  test('nothing named burn-alert survives the restoration', () => {
    // The deleted burn-alert emitter turned a computed metric into an outbound page. Restoring the
    // read model must not restore it: a burning budget is reported, never announced.
    const banned = [
      'emitBurnAlert',
      'burnSeverity',
      'burnDedupTtlSec',
      'readBurnRatios',
      'evaluateBurnAlert',
      'BurnAlert',
    ];
    const offenders = sources
      .filter((s) => banned.some((name) => new RegExp(`\\b${name}\\b`).test(s.text)))
      .map((s) => s.path)
      .sort();
    expect(offenders).toEqual([]);
  });
});
