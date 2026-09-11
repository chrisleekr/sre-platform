import { afterEach, describe, expect, test } from 'vitest';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const script = join(projectRoot, 'scripts/assert-tests-ran.mjs');
const fixtures: string[] = [];

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ReportShape {
  success: boolean;
  numPassedTests: number | string;
  numPendingTests?: number;
  numTodoTests?: number;
  files: number;
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sre-assert-tests-ran-'));
  fixtures.push(root);
  return root;
}

function reportPath(contents?: string): string {
  const path = join(fixtureRoot(), 'output.json');
  if (contents !== undefined) writeFileSync(path, contents);
  return path;
}

// Only the fields the gate reads; testResults carries one entry per test file in a real report.
function report({
  success,
  numPassedTests,
  numPendingTests = 0,
  numTodoTests = 0,
  files,
}: ReportShape): string {
  return JSON.stringify({
    success,
    numPassedTests,
    numPendingTests,
    numTodoTests,
    testResults: Array.from({ length: files }, () => ({})),
  });
}

function run(reportFile: string, expectedFiles: string): CommandResult {
  const result = spawnSync(process.execPath, [script, reportFile, expectedFiles], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
  });
  // A missing script also exits 1, which would let the failure cases pass vacuously.
  expect(result.stderr).not.toContain('Cannot find module');
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('assert-tests-ran', () => {
  test('fails when the report file is missing and names the path', () => {
    const missing = reportPath();

    const result = run(missing, '3');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(missing);
  });

  test('fails on malformed JSON', () => {
    const result = run(reportPath('{not json'), '3');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unreadable Vitest JSON report');
  });

  test('fails on a JSON null', () => {
    const result = run(reportPath('null'), '3');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('is not a report object');
  });

  test('fails on zero files and zero tests', () => {
    const result = run(reportPath(report({ success: true, numPassedTests: 0, files: 0 })), '0');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Vitest gate refused');
  });

  test('fails when every collected test was skipped', () => {
    const result = run(
      reportPath(report({ success: true, numPassedTests: 0, numPendingTests: 12, files: 3 })),
      '3',
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('passed=0, skipped=12');
  });

  test('fails when fewer files ran than the tree holds', () => {
    const result = run(reportPath(report({ success: true, numPassedTests: 12, files: 3 })), '5');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('files=3 (expected 5)');
  });

  test('fails when the reporter verdict is false', () => {
    const result = run(reportPath(report({ success: false, numPassedTests: 12, files: 3 })), '3');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('success=false');
  });

  test('fails on a non-integer passed count', () => {
    const result = run(reportPath(report({ success: true, numPassedTests: '?', files: 3 })), '3');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('passed=?');
  });

  test('passes on a complete run and prints the counts', () => {
    const result = run(reportPath(report({ success: true, numPassedTests: 12, files: 3 })), '3');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Vitest ran 3 files, 12 passed, 0 skipped.');
  });
});

// A lane sees only its own report, so the manifest it is handed covers the whole tree and the gate
// partitions it. Comparing sets rather than counts also catches the same-count-different-files
// failure a project-glob typo produces.
const UI_A = 'apps/dashboard/src/__tests__/incidents.test.tsx';
const UI_B = 'apps/dashboard/src/__tests__/theme.test.tsx';
const UI_GHOST = 'apps/dashboard/src/__tests__/ghost.test.tsx';
const BACKEND_A = 'packages/db/src/__tests__/rls.test.ts';
const WHOLE_TREE = [UI_A, UI_B, BACKEND_A];

// Vitest names test files by absolute path; the gate normalises them to repo-relative before
// comparing, so the fixture stores what a real report stores.
function laneReport(names: string[]): string {
  return JSON.stringify({
    success: true,
    numPassedTests: names.length * 2,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: names.map((name) => ({ name: join(projectRoot, name) })),
  });
}

function runLane(lane: string, manifest: string[], ran: string[]): CommandResult {
  const root = fixtureRoot();
  const manifestPath = join(root, 'manifest.txt');
  const reportFile = join(root, `${lane}.json`);
  writeFileSync(manifestPath, manifest.map((name) => `${name}\n`).join(''));
  writeFileSync(reportFile, laneReport(ran));

  const result = spawnSync(
    process.execPath,
    [script, '--lane', lane, '--manifest', manifestPath, reportFile],
    { cwd: projectRoot, env: process.env, encoding: 'utf8' },
  );
  expect(result.stderr).not.toContain('Cannot find module');
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

describe('assert-tests-ran lane partition', () => {
  test.each([
    { lane: 'ui', ran: [UI_A, UI_B] },
    { lane: 'backend', ran: [BACKEND_A] },
  ])('passes when the $lane lane ran exactly its partition', ({ lane, ran }) => {
    const result = runLane(lane, WHOLE_TREE, ran);

    expect(result.exitCode).toBe(0);
  });

  test('fails and names a lane file that never ran', () => {
    const result = runLane('ui', WHOLE_TREE, [UI_A]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(UI_B);
    // The other lane's files are not this lane's problem and must not be reported as missing.
    expect(result.stderr).not.toContain(BACKEND_A);
  });

  test('fails and names a reported file the tree does not hold', () => {
    const result = runLane('ui', [UI_A, BACKEND_A], [UI_A, UI_GHOST]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(UI_GHOST);
  });

  test('fails when the file counts match but the files differ', () => {
    const result = runLane('ui', WHOLE_TREE, [UI_A, UI_GHOST]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(UI_B);
    expect(result.stderr).toContain(UI_GHOST);
  });

  // Checked in both jobs: a botched boundary then fails on both lanes independently, even though
  // neither job can see the other's result.
  test.each([
    { lane: 'ui', manifest: [BACKEND_A] },
    { lane: 'backend', manifest: [UI_A] },
  ])('fails when the $lane partition is empty', ({ lane, manifest }) => {
    const result = runLane(lane, manifest, []);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/empty/i);
    expect(result.stderr).toContain(lane);
  });
});
