// Fails a test gate whose Vitest run did not cover the tree. Under Bun 1.3 the `node` shim started
// Vitest, collected zero tests and exited 0, so the gate passed without running a test. Bun 1.4
// collects normally, but a dropped include glob shrinks the run just as silently, so what the report
// says ran is compared with what the caller found on disk.
//
// A lane sees only its own report, so the manifest it is handed covers the whole tree and this gate
// partitions it. Comparing sets rather than counts also catches the same-count-different-files
// failure a project-glob typo produces.
//
// Usage: node scripts/assert-tests-ran.mjs --lane <backend|ui> --manifest <file> <report>
//        node scripts/assert-tests-ran.mjs <report> <expected-file-count>

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const LANES = ['ui', 'backend'];
const USAGE =
  'usage: node scripts/assert-tests-ran.mjs --lane <backend|ui> --manifest <file> <report>';

function refuse(message) {
  console.error(message);
  process.exit(1);
}

/**
 * The lane a test file belongs to.
 *
 * Deliberately a second, independent expression of the boundary the Vitest include globs express.
 * Importing those globs would turn this gate into an identity check that passes whatever they say.
 */
function laneOf(file) {
  return file.startsWith('apps/dashboard/') ? 'ui' : 'backend';
}

/** Repo-relative form of a report entry, which Vitest writes as an absolute path. */
function repoRelative(name) {
  return relative(repoRoot, resolve(repoRoot, String(name ?? '')));
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--lane' || arg === '--manifest') {
      flags[arg.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(process.argv.slice(2));
const laneMode = flags.lane !== undefined || flags.manifest !== undefined;

if (laneMode && (!LANES.includes(flags.lane) || !flags.manifest || positional.length !== 1)) {
  refuse(USAGE);
}
if (!laneMode && (positional.length !== 2 || !/^\d+$/.test(positional[1] ?? ''))) {
  refuse('usage: node scripts/assert-tests-ran.mjs <report> <expected-file-count>');
}

const reportPath = positional[0];

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  refuse(`Unreadable Vitest JSON report ${reportPath}: ${error.message}`);
}

if (report === null || typeof report !== 'object' || !Array.isArray(report.testResults)) {
  refuse(`Vitest JSON report ${reportPath} is not a report object.`);
}

let expectedFiles = Number(positional[1]);

if (laneMode) {
  const lane = flags.lane;
  const manifest = readFileSync(flags.manifest, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => repoRelative(line));

  const partitions = { ui: [], backend: [] };
  for (const file of manifest) partitions[laneOf(file)]?.push(file);

  if (partitions.ui.length + partitions.backend.length !== manifest.length) {
    refuse(
      `Vitest gate refused: ${manifest.length} test files partition into ${partitions.ui.length} ui and ${partitions.backend.length} backend, which does not account for every file.`,
    );
  }

  // Checked for both lanes, not just this one: a botched boundary then fails in both jobs
  // independently, even though neither job can see the other's result.
  for (const name of LANES) {
    if (partitions[name].length === 0) {
      refuse(
        `Vitest gate refused: the ${name} partition of the tree is empty, so the lane boundary no longer matches the files on disk.`,
      );
    }
  }

  const ran = new Set(report.testResults.map((result) => repoRelative(result?.name)));
  const expected = new Set(partitions[lane]);
  const never = partitions[lane].filter((file) => !ran.has(file));
  const stray = [...ran].filter((file) => !expected.has(file));

  if (never.length > 0 || stray.length > 0) {
    if (never.length > 0) console.error(`In the tree but never ran: ${never.join(', ')}`);
    if (stray.length > 0) console.error(`Ran but not in the tree: ${stray.join(', ')}`);
    refuse(`Vitest gate refused: the ${lane} lane did not run its partition of the tree.`);
  }

  expectedFiles = partitions[lane].length;
}

const files = report.testResults.length;
const passed = report.numPassedTests;
const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
const complete =
  report.success === true && Number.isInteger(passed) && passed > 0 && files === expectedFiles;

if (!complete) {
  refuse(
    `Vitest gate refused: success=${report.success}, files=${files} (expected ${expectedFiles}), passed=${passed}, skipped=${skipped}.`,
  );
}

console.log(`Vitest ran ${files} files, ${passed} passed, ${skipped} skipped.`);
