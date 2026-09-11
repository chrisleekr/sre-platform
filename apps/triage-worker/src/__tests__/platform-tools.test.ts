import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeSearchRunbooksTool,
  makeFetchBlastRadiusTool,
  makeFetchRecentDeploysTool,
  makeInvestigateCodeTool,
  makeResolveEntityContextTool,
  makeSearchIncidentEvidenceTool,
  makeFetchSloStatusTool,
} from '@sre/agent-tools';
import type { Db, Embedder } from '@sre/db';

// `engine/shared.ts` and `CONTEXT.md` both assert WHICH tools are the always-present platform
// set — the ones that bind independently of a specific connector. The composition root cannot be
// imported because it opens real connections and runs the worker loop at module top level, so the
// claim is pinned in two halves: factory names and unconditional composition-root bindings.
// `fetch_slo_status` joins the set because it reads the platform's own SLO tables and the latest
// persisted burn event: no live connector query, so it binds for every tenant, evaluated or not.
const PLATFORM_TOOL_NAMES = [
  'fetch_blast_radius',
  'fetch_recent_deploys',
  'fetch_slo_status',
  'investigate_code',
  'resolve_entity_context',
  'search_incident_evidence',
  'search_runbooks',
];

describe('the platform tool set', () => {
  test('the platform tool factories produce exactly the asserted names', () => {
    // The deps are never touched: only the handlers read db/embedder, and no handler runs here.
    const db = {} as Db;
    const embedder = {} as Embedder;

    const tools = [
      makeSearchRunbooksTool({ embedder, db }),
      makeFetchBlastRadiusTool({ db }),
      makeFetchRecentDeploysTool({ db }),
      makeInvestigateCodeTool({ db }),
      makeResolveEntityContextTool({ db }),
      makeSearchIncidentEvidenceTool({ db }),
      makeFetchSloStatusTool({ db }),
    ];

    expect(tools.map((t) => t.name).sort()).toEqual(PLATFORM_TOOL_NAMES);
  });

  test('the composition root binds exactly those platform tool factories, unconditionally', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'),
      'utf8',
    );
    const block = /const tools = \[([\s\S]*?)\];/.exec(src);
    expect(
      block,
      'index.ts must still bind the platform tools as `const tools = [ ... ]`',
    ).not.toBe(null);

    // The exact set in the array the worker receives as `deps.tools`. A count would pass a rename,
    // which is the drift being pinned; per-connector tools are appended later in `worker.runtime()`.
    expect(block![1]!.match(/make\w+Tool\(/g)).toEqual([
      'makeSearchRunbooksTool(',
      'makeFetchBlastRadiusTool(',
      'makeFetchRecentDeploysTool(',
      'makeInvestigateCodeTool(',
      'makeResolveEntityContextTool(',
      'makeSearchIncidentEvidenceTool(',
      'makeFetchSloStatusTool(',
    ]);
    // "Unconditional": no spread or conditional could vary the set per deployment or per tenant.
    expect(block![1]).not.toMatch(/\.\.\.|\?|&&/);

    // `const` binds the reference, not the contents, so reading the literal alone would stay green
    // while a later `tools.push(...)` changed the set the worker actually receives. Scan from the
    // literal to the end of the module (the handoff to TriageWorker is the only other use).
    const afterLiteral = src.slice(block!.index + block![0].length);
    expect(afterLiteral).not.toMatch(
      /\btools\s*\.\s*(push|pop|splice|unshift|shift|fill|copyWithin|sort|reverse)\s*\(/,
    );
    expect(afterLiteral).not.toMatch(/\btools\s*=[^=]/);
  });
});
