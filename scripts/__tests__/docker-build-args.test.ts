import { afterEach, describe, expect, test } from 'vitest';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const script = join(projectRoot, 'scripts/ci/docker-build.sh');
const image = 'registry.example/sre-platform';
const fixtures: string[] = [];

interface BuildResult {
  exitCode: number;
  stderr: string;
  /** Every argument the script handed to `docker`, in order. */
  argv: string[];
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sre-docker-build-'));
  fixtures.push(root);
  return root;
}

// Puts a fake `docker` first on PATH that records its argv and succeeds. Nothing is built, so the
// assertions are about the argv the script composes and nothing else. `cwdFiles` seeds the working
// directory, so a test can prove a tag is not subject to pathname expansion.
function runDockerBuild(args: string[], cwdFiles: string[] = []): BuildResult {
  const root = fixtureRoot();
  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  for (const name of cwdFiles) writeFileSync(join(root, name), '');
  const capture = join(root, 'argv.txt');
  writeFileSync(
    join(binDir, 'docker'),
    `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" >> '${capture}'; done\nexit 0\n`,
    { mode: 0o755 },
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    GIT_SHA: 'deadbee',
  };
  // The stamped version must come from the tags, not from an ambient value CI happens to export.
  delete env.SRE_VERSION;
  // A temp cwd, not the repo root: the fake docker never reads the build context.
  const result = spawnSync('sh', [script, ...args], { cwd: root, env, encoding: 'utf8' });

  const argv = existsSync(capture) ? readFileSync(capture, 'utf8').split('\n').filter(Boolean) : [];
  return { exitCode: result.status ?? 1, stderr: result.stderr, argv };
}

/** Every value that follows `flag`, so a repeated flag is visible as a repeated value. */
function valuesOf(argv: string[], flag: string): string[] {
  return argv.flatMap((arg, index) => (arg === flag ? [argv[index + 1] ?? ''] : []));
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('docker-build tag handling', () => {
  test('passes one --tag argument per flag and stamps the version from the first tag', () => {
    const result = runDockerBuild(['--image', image, '--tag', 'v1.2.3', '--tag', 'latest']);

    expect(result.exitCode).toBe(0);
    expect(valuesOf(result.argv, '--tag')).toEqual([`${image}:1.2.3`, `${image}:latest`]);
    // A release passes the version first, so the stamp reads 1.2.3 rather than the literal `latest`.
    expect(valuesOf(result.argv, '--build-arg')).toContain('SRE_VERSION=1.2.3');
  });

  test('keeps the single-tag local build unchanged', () => {
    const result = runDockerBuild(['--image', image, '--tag', 'v1.2.3']);

    expect(result.exitCode).toBe(0);
    expect(valuesOf(result.argv, '--tag')).toEqual([`${image}:1.2.3`]);
    expect(valuesOf(result.argv, '--build-arg')).toEqual([
      'SRE_VERSION=1.2.3',
      'SRE_REVISION=deadbee',
    ]);
    expect(result.argv).toContain('--load');
    expect(result.argv).not.toContain('--push');
  });

  test('does not let a tag holding a glob character expand against the working directory', () => {
    const result = runDockerBuild(
      ['--image', image, '--tag', 'C*.md'],
      ['CHANGELOG.md', 'CONTRIBUTING.md'],
    );

    expect(result.exitCode).toBe(0);
    expect(valuesOf(result.argv, '--tag')).toEqual([`${image}:C*.md`]);
  });
});

describe('docker-build registry cache', () => {
  test('requests the registry build cache only when pushing', () => {
    const pushed = runDockerBuild([
      '--image',
      image,
      '--tag',
      'latest',
      '--platforms',
      'linux/amd64,linux/arm64',
      '--push',
    ]);

    expect(pushed.exitCode).toBe(0);
    expect(pushed.argv).toContain('--push');
    expect(valuesOf(pushed.argv, '--cache-from')).toEqual([
      `type=registry,ref=${image}:buildcache`,
    ]);
    // image-manifest=true because the registry rejects the default OCI manifest list for cache refs.
    expect(valuesOf(pushed.argv, '--cache-to')).toEqual([
      `type=registry,ref=${image}:buildcache,mode=max,image-manifest=true`,
    ]);

    // The cache round-trips through the registry and needs the credentials only a push has.
    const local = runDockerBuild(['--image', image, '--tag', 'ci']);

    expect(local.exitCode).toBe(0);
    expect(local.argv).not.toContain('--cache-from');
    expect(local.argv).not.toContain('--cache-to');
  });

  test('writes only the given cache ref while still reading the default one', () => {
    const devRef = `${image}:buildcache-dev`;
    const result = runDockerBuild([
      '--image',
      image,
      '--tag',
      'dev',
      '--platforms',
      'linux/amd64',
      '--cache-ref',
      devRef,
      '--push',
    ]);

    expect(result.exitCode).toBe(0);
    // Trust flows one way: a lower-trust build warms from the default ref but cannot write to it.
    expect(valuesOf(result.argv, '--cache-from')).toEqual([
      `type=registry,ref=${image}:buildcache`,
      `type=registry,ref=${devRef}`,
    ]);
    expect(valuesOf(result.argv, '--cache-to')).toEqual([
      `type=registry,ref=${devRef},mode=max,image-manifest=true`,
    ]);
  });
});

describe('docker-build argument guards', () => {
  test.each([
    {
      name: 'a pushed build without platforms',
      args: ['--image', image, '--tag', 'latest', '--push'],
      error: 'A pushed image requires --platforms.',
    },
    {
      name: 'a multi-platform build without --push',
      args: ['--image', image, '--tag', 'ci', '--platforms', 'linux/amd64,linux/arm64'],
      error: 'A local image can load only one platform.',
    },
    {
      name: 'a build with no tag at all',
      args: ['--image', image],
      error: 'Usage: docker-build.sh',
    },
    {
      name: 'an empty tag',
      args: ['--image', image, '--tag', ''],
      error: 'A tag cannot be empty.',
    },
    {
      // An empty tag used to append only a separator: the usage guard passed, the field vanished,
      // and the build pushed image:latest stamped SRE_VERSION=latest.
      name: 'an empty tag followed by a real one',
      args: ['--image', image, '--tag', '', '--tag', 'latest'],
      error: 'A tag cannot be empty.',
    },
  ])('refuses $name', ({ args, error }) => {
    const result = runDockerBuild(args);

    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain(error);
    expect(result.argv).toEqual([]);
  });
});
