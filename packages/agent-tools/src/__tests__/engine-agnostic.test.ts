import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The tool layer must stay engine-agnostic. No LLM provider SDK may be imported by any
// production module here — including subpath or dynamic imports — nor declared in the package
// manifest. Engine bindings live in the triage worker, not in this package.
const FORBIDDEN_IMPORT = /(?:from|import\()\s*['"](?:openai|@anthropic-ai\/sdk)(?:\/[^'"]*)?['"]/;
const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(here, '..');
const sources = readdirSync(sourceRoot, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

describe('engine-agnostic tool layer (C3)', () => {
  it('imports no LLM provider SDK in any production source (incl. subpath/dynamic)', () => {
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const src = readFileSync(join(sourceRoot, file), 'utf8');
      expect(FORBIDDEN_IMPORT.test(src), `${file} must not import an LLM provider SDK`).toBe(false);
    }
  });

  it('declares no LLM provider SDK in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(sourceRoot, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps).not.toHaveProperty('openai');
    expect(deps).not.toHaveProperty('@anthropic-ai/sdk');
  });
});
