#!/usr/bin/env bun

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT_ROOT = path.resolve(process.argv[2] ?? '.');
const connectorRoot = path.join(PROJECT_ROOT, 'packages/connectors/src');
const { CONNECTOR_TYPES } = await import(pathToFileURL(path.join(connectorRoot, 'catalog.ts')));
const { INBOUND_SURFACES } = await import(
  pathToFileURL(path.join(connectorRoot, 'inbound/catalog.ts'))
);

function providerDirectories(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '__tests__')
    .map((entry) => entry.name)
    .sort();
}

function assertCatalogMatchesDirectories(label, root, declared) {
  const directories = providerDirectories(root);
  const expected = [...declared].sort();
  if (JSON.stringify(directories) === JSON.stringify(expected)) return;
  console.error(`${label} provider folders and catalog entries differ`);
  console.error(`folders: ${directories.join(', ') || '(none)'}`);
  console.error(`catalog: ${expected.join(', ') || '(none)'}`);
  process.exitCode = 1;
}

assertCatalogMatchesDirectories(
  'Data-source',
  path.join(connectorRoot, 'data-sources'),
  CONNECTOR_TYPES,
);
assertCatalogMatchesDirectories('Inbound', path.join(connectorRoot, 'inbound'), INBOUND_SURFACES);
