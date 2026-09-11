import { afterEach, describe, expect, test } from 'vitest';

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const script = join(projectRoot, 'scripts/test-ci.sh');
const fixtures: string[] = [];

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sre-test-ci-'));
  fixtures.push(root);
  return root;
}

// Puts a fake `node` first on PATH. The runtime guard is the only line that runs before Vitest
// would start, so it is the only line these cases may reach.
function runWithFakeNode(root: string, wrapper: string): CommandResult {
  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'node'), wrapper, { mode: 0o755 });
  // A valid lane, so the guard is the only thing that can fail. A temp cwd, not the repo root: if
  // the guard ever let a fake runtime through, the Vitest entrypoint would be missing here instead
  // of a nested run clobbering the lane's JSON report.
  const result = spawnSync('bash', [script, 'backend'], {
    cwd: root,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    encoding: 'utf8',
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('test-ci runtime guard', () => {
  test('refuses a node that resolves to the Bun shim', () => {
    // Same shape as the oven/bun image, where node is a symlink to bun.
    const result = runWithFakeNode(fixtureRoot(), '#!/bin/sh\nexec bun "$@"\n');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('node resolves to the Bun shim');
    expect(result.stdout).not.toContain('test runtime:');
  });

  test('refuses a node older than 22.12', () => {
    const root = fixtureRoot();
    // `-e` scripts honour `--require`, so the preload rewrites the version the guard reads.
    const preload = join(root, 'old-node.cjs');
    writeFileSync(
      preload,
      'Object.defineProperty(process.versions, "node", { value: "22.11.0" });\n',
    );
    const result = runWithFakeNode(
      root,
      `#!/bin/sh\nexec "${process.execPath}" --require "${preload}" "$@"\n`,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('is too old');
    expect(result.stdout).not.toContain('test runtime:');
  });
});
