import { describe, expect, test } from 'vitest';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

function source(path: string): string {
  return readFileSync(join(projectRoot, path), 'utf8');
}

const vitestConfig = source('vitest.config.ts');
const gitlabCi = source('.gitlab-ci.yml');
const githubCi = source('.github/workflows/ci.yml');

/** The lanes both providers run. One script per lane, invoked identically on each provider. */
const LANES = ['typecheck', 'lint', 'guards', 'test', 'test-ui', 'build'];

/** Every top-level key of a YAML document, which for these files is every job plus the globals. */
function topLevelKeys(yaml: string): string[] {
  return yaml.split('\n').flatMap((line) => line.match(/^([A-Za-z][\w.-]*):/)?.[1] ?? []);
}

/** The lines of one top-level block, up to the next unindented line. */
function blockLines(yaml: string, key: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.indexOf(`${key}:`);
  expect(start, `${key} is not a top-level key`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\S/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every top-level job whose block declares the given stage. */
function jobsInStage(yaml: string, stage: string): string[] {
  const pattern = new RegExp(`^\\s+stage:\\s*${stage}\\s*$`);
  return topLevelKeys(yaml).filter((key) =>
    blockLines(yaml, key).some((line) => pattern.test(line)),
  );
}

/** The job names a job waits for, in either the inline or the block list form. */
function needsOf(yaml: string, job: string): string[] {
  const lines = blockLines(yaml, job);
  const at = lines.findIndex((line) => /^\s*needs:/.test(line));
  if (at === -1) return [];

  const inline = lines[at]!.match(/needs:\s*\[(.*)\]/);
  if (inline) {
    return inline[1]!
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  const collected: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const item = line.match(/^\s+-\s+(\S+)\s*$/);
    if (!item) break;
    collected.push(item[1]!);
  }
  return collected;
}

describe('vitest project split', () => {
  test('declares exactly a ui project and a backend project', () => {
    expect(vitestConfig).toContain('projects:');

    const names = [...vitestConfig.matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1]!);

    expect(names.sort()).toEqual(['backend', 'ui']);
  });

  test('confines globalSetup to the backend project', () => {
    const first = vitestConfig.indexOf('globalSetup');

    expect(first).toBeGreaterThanOrEqual(0);
    // A second declaration would boot a second container stack and migrate twice.
    expect(vitestConfig.indexOf('globalSetup', first + 1)).toBe(-1);

    const owner = [...vitestConfig.matchAll(/name:\s*'([^']+)'/g)]
      .filter((match) => (match.index ?? 0) < first)
      .at(-1);

    expect(owner?.[1]).toBe('backend');
  });
});

describe('CI lane parity', () => {
  test.each([
    { provider: 'GitLab', yaml: gitlabCi },
    { provider: 'GitHub', yaml: githubCi },
  ])('$provider invokes every lane script and no aggregator', ({ yaml }) => {
    for (const lane of LANES) expect(yaml).toContain(`scripts/ci/${lane}.sh`);
    // verify.sh stays as the local reproduction of CI; no provider runs it.
    expect(yaml).not.toContain('scripts/ci/verify.sh');
  });

  test('gates publish-image on every job in the test stage', () => {
    const needs = needsOf(gitlabCi, 'publish-image');
    const gates = jobsInStage(gitlabCi, 'test');

    // Anti-vacuity: a walk that discovered no gates would satisfy the set equality below without
    // having read a single job.
    expect(gates.length).toBeGreaterThan(0);
    expect(gates).toEqual(expect.arrayContaining([...LANES, 'docs', 'container']));

    // A present needs list overrides stage ordering, so a job left out of it is not waited for and
    // publish-image would publish past a gate that never ran. Set equality, not a subset: a new
    // test-stage job that nobody added here has to fail.
    expect([...needs].sort()).toEqual([...gates].sort());

    expect(needs).not.toContain('verify');
    for (const job of needs) expect(topLevelKeys(gitlabCi)).toContain(job);
  });

  test('verify.sh reproduces exactly the lanes both providers run', () => {
    const verify = source('scripts/ci/verify.sh');
    const invoked = [...verify.matchAll(/^\s*bash scripts\/ci\/([\w-]+)\.sh/gm)].map(
      (match) => match[1]!,
    );

    // Set equality: a seventh lane added to both providers but not here silently stops CI from
    // being reproducible locally.
    expect(invoked.sort()).toEqual([...LANES].sort());
  });
});
