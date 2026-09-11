import { afterEach, describe, expect, test } from 'vitest';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const architectureScript = join(projectRoot, 'scripts/check-connector-architecture.sh');
const jsDocScript = join(projectRoot, 'scripts/check-public-jsdoc.mjs');
const fixtures: string[] = [];

interface CommandResult {
  exitCode: number;
  output: string;
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sre-policy-check-'));
  fixtures.push(root);
  return root;
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function run(command: string, args: string[], cwd = projectRoot): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: 'utf8',
  });
  return {
    exitCode: result.status ?? 1,
    output: `${result.stdout}${result.stderr}`,
  };
}

function createJsDocFixture(source: string): string {
  const root = fixtureRoot();
  write(
    root,
    'packages/example/package.json',
    JSON.stringify({ name: '@fixture/example', type: 'module', main: 'src/index.ts' }),
  );
  write(
    root,
    'packages/example/tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  write(root, 'packages/example/src/index.ts', source);
  return root;
}

function createArchitectureFixture(): string {
  const root = fixtureRoot();
  write(
    root,
    'packages/connectors/src/catalog.ts',
    "export const CONNECTOR_TYPES = ['example'] as const;\n",
  );
  write(
    root,
    'packages/connectors/src/inbound/catalog.ts',
    "export const INBOUND_SURFACES = ['slack'] as const;\n",
  );
  write(root, 'packages/connectors/src/data-sources/example/index.ts', 'export {};\n');
  write(root, 'packages/connectors/src/inbound/slack/index.ts', 'export {};\n');
  return root;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('public JSDoc policy', () => {
  test('accepts a documented public function with matching parameters', () => {
    const root = createJsDocFixture(`/**
 * Greets a person.
 *
 * @param name - Person to greet.
 */
export function greet(name: string): string {
  return \`Hello, \${name}.\`;
}
`);

    const result = run('bun', [jsDocScript, '--project-root', root]);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.output).toContain('Public API JSDoc validation passed');
  });

  test.each([
    {
      name: 'missing documentation',
      source: 'export function greet(name: string): string { return name; }\n',
      error: 'expected one JSDoc block, found 0',
    },
    {
      name: 'missing parameter documentation',
      source:
        '/** Greets a person. */\nexport function greet(name: string): string { return name; }\n',
      error: 'expected @param tags [name], found []',
    },
  ])('rejects $name', ({ source, error }) => {
    const result = run('bun', [jsDocScript, '--project-root', createJsDocFixture(source)]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(error);
  });

  test('ignores filenames appended by lint-staged', () => {
    const root = createJsDocFixture(`/**
 * Greets a person.
 *
 * @param name - Person to greet.
 */
export function greet(name: string): string {
  return name;
}
`);

    const result = run('bun', [jsDocScript, 'packages/example/src/index.ts'], root);

    expect(result).toMatchObject({ exitCode: 0 });
  });

  test.each([
    { blankLines: 8, expectedExitCode: 0 },
    { blankLines: 9, expectedExitCode: 1 },
  ])(
    'enforces the 12-line JSDoc boundary with $blankLines blank lines',
    ({ blankLines, expectedExitCode }) => {
      const padding = Array.from({ length: blankLines }, () => ' *').join('\n');
      const root = createJsDocFixture(`/**
 * Greets a person.
${padding}
 * @param name - Person to greet.
 */
export function greet(name: string): string {
  return name;
}
`);

      const result = run('bun', [jsDocScript, '--project-root', root]);

      expect(result.exitCode).toBe(expectedExitCode);
      if (expectedExitCode === 1) expect(result.output).toContain('JSDoc exceeds 12 lines');
    },
  );
});

describe('connector architecture policy', () => {
  test('accepts catalog-aligned provider folders with entry points', () => {
    const root = createArchitectureFixture();
    write(
      root,
      'packages/connectors/src/data-sources/example/connector.ts',
      `${Array.from({ length: 25 }, () => '// line').join('\n')}\n`,
    );
    write(
      root,
      'packages/connectors/src/data-sources/example/tools.ts',
      `${Array.from({ length: 500 }, () => '// line').join('\n')}\n`,
    );
    write(
      root,
      'packages/connectors/src/data-sources/example/__tests__/connector.test.ts',
      `${Array.from({ length: 600 }, () => '// line').join('\n')}\n`,
    );

    const result = run('bash', [architectureScript, root]);

    expect(result).toMatchObject({ exitCode: 0 });
  });

  test.each([
    {
      name: 'a provider without an entry point',
      mutate(root: string) {
        rmSync(join(root, 'packages/connectors/src/data-sources/example/index.ts'));
      },
      error: 'Connector provider is missing index.ts',
    },
    {
      name: 'catalog and provider-folder drift',
      mutate(root: string) {
        write(root, 'packages/connectors/src/data-sources/orphan/index.ts', 'export {};\n');
      },
      error: 'Data-source provider folders and catalog entries differ',
    },
    {
      name: 'a legacy flat provider module',
      mutate(root: string) {
        write(root, 'packages/connectors/src/github.ts', 'export {};\n');
      },
      error: 'Connector providers must live under data-sources/<provider>',
    },
    {
      name: 'an oversized provider module',
      mutate(root: string) {
        write(
          root,
          'packages/connectors/src/data-sources/example/connector.ts',
          `${Array.from({ length: 501 }, () => '// line').join('\n')}\n`,
        );
      },
      error: 'Connector module exceeds 500 lines',
    },
    {
      name: 'an undersized provider fragment',
      mutate(root: string) {
        write(
          root,
          'packages/connectors/src/data-sources/example/connector.ts',
          `${Array.from({ length: 24 }, () => '// line').join('\n')}\n`,
        );
      },
      error: 'Connector module is too fragmented, minimum 25 lines',
    },
    {
      name: 'an oversized provider test module',
      mutate(root: string) {
        write(
          root,
          'packages/connectors/src/data-sources/example/__tests__/connector.test.ts',
          `${Array.from({ length: 601 }, () => '// line').join('\n')}\n`,
        );
      },
      error: 'Connector test module exceeds 600 lines',
    },
  ])('rejects $name', ({ mutate, error }) => {
    const root = createArchitectureFixture();
    mutate(root);

    const result = run('bash', [architectureScript, root]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(error);
  });
});

// Published documentation must never present the internal pipeline as the thing that builds and
// ships this project. The bare word GitLab stays legal: several connector pages describe a product
// feature a tenant configures against their own instance. These tokens have no second meaning.
const DELIVERY_PIPELINE_TOKENS = ['CI_REGISTRY', 'CI_COMMIT', '.gitlab-ci'];
const DOCS_TEXT_EXTENSIONS = ['.md', '.css'];

describe('published documentation policy', () => {
  test('never presents the internal pipeline as our delivery pipeline', () => {
    const docsRoot = join(projectRoot, 'docs');
    const pages = readdirSync(docsRoot, { recursive: true, encoding: 'utf8' }).filter((name) =>
      DOCS_TEXT_EXTENSIONS.some((extension) => name.endsWith(extension)),
    );

    // A walk that finds nothing would pass without reading a page.
    expect(pages.length).toBeGreaterThan(0);

    const hits = pages.flatMap((name) =>
      readFileSync(join(docsRoot, name), 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          DELIVERY_PIPELINE_TOKENS.filter((token) => line.includes(token)).map(
            (token) => `${name}:${index + 1} names ${token}`,
          ),
        ),
    );

    expect(hits).toEqual([]);
  });
});
