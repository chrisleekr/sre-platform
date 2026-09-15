import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, Embedder } from '@sre/db';
import type { SnapshotCache } from '@sre/queue';
import { makePlatformTools } from '../platform-tools';

// Import the actual composition without starting the worker's external connections and loop.
const PLATFORM_TOOL_NAMES = [
  'fetch_blast_radius',
  'fetch_recent_deploys',
  'fetch_slo_status',
  'investigate_code',
  'read_topology_endpoint_evidence',
  'read_topology_runtime',
  'read_topology_source_file',
  'read_topology_sources',
  'resolve_entity_context',
  'search_incident_evidence',
  'search_runbooks',
];

describe('the platform tool set', () => {
  test('the platform tool factories produce exactly the asserted names', () => {
    // The deps are never touched: only the handlers read db/embedder, and no handler runs here.
    const db = {} as Db;
    const embedder = {} as Embedder;

    const tools = makePlatformTools({ db, embedder, cache: {} as SnapshotCache });

    expect(tools.map((t) => t.name).sort()).toEqual(PLATFORM_TOOL_NAMES);
  });

  test('the composition root binds exactly those platform tool factories, unconditionally', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'),
      'utf8',
    );
    const factory = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'platform-tools.ts'),
      'utf8',
    );
    const block = factory.match(/return\s*\[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    expect(block![1]).not.toMatch(/\.\.\.|\?|&&/);
    const binding = 'const tools = makePlatformTools({ db: appDb.db, embedder, cache });';
    expect(src).toContain(binding);
    const afterLiteral = src.slice(src.indexOf(binding) + binding.length);
    expect(afterLiteral).not.toMatch(
      /\btools\s*\.\s*(push|pop|splice|unshift|shift|fill|copyWithin|sort|reverse)\s*\(/,
    );
    expect(afterLiteral).not.toMatch(/\btools\s*=[^=]/);
  });
});
