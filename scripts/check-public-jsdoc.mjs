#!/usr/bin/env bun

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const rootArgumentIndex = process.argv.indexOf('--project-root');
if (rootArgumentIndex >= 0 && !process.argv[rootArgumentIndex + 1]) {
  throw new Error('--project-root requires a path');
}
const PROJECT_ROOT = path.resolve(
  rootArgumentIndex >= 0 ? process.argv[rootArgumentIndex + 1] : process.cwd(),
);
const PACKAGES_ROOT = path.join(PROJECT_ROOT, 'packages');

const PUBLIC_PACKAGES = fs
  .readdirSync(PACKAGES_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const root = path.join(PACKAGES_ROOT, entry.name);
    const packageJson = path.join(root, 'package.json');
    const tsconfig = path.join(root, 'tsconfig.json');
    if (!fs.existsSync(packageJson) || !fs.existsSync(tsconfig)) return null;
    const manifest = JSON.parse(fs.readFileSync(packageJson, 'utf8'));
    const entrypoint = path.join(root, manifest.main ?? 'src/index.ts');
    if (!fs.existsSync(entrypoint)) return null;
    return { name: manifest.name ?? entry.name, entrypoint, tsconfig };
  })
  .filter(Boolean);

const MAX_SUMMARY_CHARS = 180;
const MAX_PARAM_DESCRIPTION_CHARS = 120;
const MAX_JSDOC_LINES = 12;

function diagnosticText(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function parseProject(tsconfig) {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    tsconfig,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(diagnosticText(diagnostic));
      },
    },
  );
  if (!parsed) throw new Error(`could not parse ${tsconfig}`);
  return parsed;
}

function callableDeclaration(declaration) {
  if (ts.isFunctionDeclaration(declaration)) {
    return { functionLike: declaration, documentationNode: declaration };
  }
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer))
  ) {
    const statement = declaration.parent.parent;
    return {
      functionLike: declaration.initializer,
      documentationNode: ts.isVariableStatement(statement) ? statement : declaration,
    };
  }
  return null;
}

function documentedDeclaration(declaration) {
  return ts.isClassDeclaration(declaration) ? declaration : null;
}

function jsDocText(comment) {
  return ts.getTextOfJSDocComment(comment)?.trim() ?? '';
}

function parameterName(parameter) {
  return ts.isIdentifier(parameter.name) ? parameter.name.text : null;
}

function sourceLocation(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${path.relative(PROJECT_ROOT, sourceFile.fileName)}:${line + 1}:${character + 1}`;
}

function endsAsSentence(value) {
  return /[.!?]$/.test(value);
}

function validatePublicFunction(packageName, exportName, declaration, callable, failures) {
  const sourceFile = declaration.getSourceFile();
  const location = sourceLocation(sourceFile, declaration);
  const prefix = `${location} ${packageName}.${exportName}`;
  const docs = ts
    .getJSDocCommentsAndTags(callable.documentationNode)
    .filter((node) => ts.isJSDoc(node));

  if (docs.length !== 1) {
    failures.push(`${prefix}: expected one JSDoc block, found ${docs.length}`);
    return;
  }

  const [doc] = docs;
  const summary = jsDocText(doc.comment);
  if (!summary) failures.push(`${prefix}: JSDoc needs a concise summary`);
  else {
    if (summary.length > MAX_SUMMARY_CHARS) {
      failures.push(`${prefix}: summary exceeds ${MAX_SUMMARY_CHARS} characters`);
    }
    if (!endsAsSentence(summary)) failures.push(`${prefix}: summary must be a complete sentence`);
  }

  const blockLines = sourceFile.text.slice(doc.pos, doc.end).split(/\r?\n/).length;
  if (blockLines > MAX_JSDOC_LINES) {
    failures.push(`${prefix}: JSDoc exceeds ${MAX_JSDOC_LINES} lines`);
  }

  const expected = [];
  for (const parameter of callable.functionLike.parameters) {
    const name = parameterName(parameter);
    if (!name) {
      failures.push(`${prefix}: public parameters must be named before they can be documented`);
      continue;
    }
    expected.push(name);
  }

  const tags = [...(doc.tags ?? [])].filter((tag) => ts.isJSDocParameterTag(tag));
  const actual = tags.map((tag) => tag.name.getText(sourceFile));
  if (new Set(actual).size !== actual.length) {
    failures.push(`${prefix}: duplicate @param tags are not allowed`);
  }
  if (expected.join('\0') !== actual.join('\0')) {
    failures.push(
      `${prefix}: expected @param tags [${expected.join(', ')}], found [${actual.join(', ')}]`,
    );
  }

  for (const tag of tags) {
    const name = tag.name.getText(sourceFile);
    const description = jsDocText(tag.comment);
    if (tag.typeExpression) {
      failures.push(`${prefix}: @param ${name} must not duplicate its TypeScript type`);
    }
    if (!/^@param\s+\S+\s+-\s+/.test(tag.getText(sourceFile))) {
      failures.push(`${prefix}: @param ${name} must use "@param name - explanation"`);
    }
    if (!description) failures.push(`${prefix}: @param ${name} needs an explanation`);
    else {
      if (description.length > MAX_PARAM_DESCRIPTION_CHARS) {
        failures.push(
          `${prefix}: @param ${name} exceeds ${MAX_PARAM_DESCRIPTION_CHARS} characters`,
        );
      }
      if (!endsAsSentence(description)) {
        failures.push(`${prefix}: @param ${name} must be a complete sentence`);
      }
    }
  }
}

function validatePublicClass(packageName, exportName, declaration, failures) {
  const sourceFile = declaration.getSourceFile();
  const location = sourceLocation(sourceFile, declaration);
  const prefix = `${location} ${packageName}.${exportName}`;
  const docs = ts.getJSDocCommentsAndTags(declaration).filter((node) => ts.isJSDoc(node));

  if (docs.length !== 1) {
    failures.push(`${prefix}: expected one class JSDoc block, found ${docs.length}`);
    return;
  }

  const summary = jsDocText(docs[0].comment);
  if (!summary) failures.push(`${prefix}: class JSDoc needs a concise summary`);
  else {
    if (summary.length > MAX_SUMMARY_CHARS) {
      failures.push(`${prefix}: class summary exceeds ${MAX_SUMMARY_CHARS} characters`);
    }
    if (!endsAsSentence(summary)) {
      failures.push(`${prefix}: class summary must be a complete sentence`);
    }
  }
}

function validatePackage(specification, failures) {
  const parsed = parseProject(specification.tsconfig);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const checker = program.getTypeChecker();
  const entrypoint = program.getSourceFile(path.resolve(specification.entrypoint));
  if (!entrypoint) throw new Error(`could not load ${specification.entrypoint}`);
  const moduleSymbol = checker.getSymbolAtLocation(entrypoint);
  if (!moduleSymbol) throw new Error(`could not resolve exports from ${specification.entrypoint}`);

  const visited = new Set();
  let callableCount = 0;
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    for (const declaration of symbol.declarations ?? []) {
      const callable = callableDeclaration(declaration);
      const key = `${declaration.getSourceFile().fileName}:${declaration.pos}`;
      if (visited.has(key)) continue;
      visited.add(key);
      if (callable) {
        callableCount += 1;
        validatePublicFunction(specification.name, exported.name, declaration, callable, failures);
        continue;
      }
      const documented = documentedDeclaration(declaration);
      if (documented) {
        validatePublicClass(specification.name, exported.name, documented, failures);
      }
    }
  }
  return callableCount;
}

const failures = [];
let callableCount = 0;
for (const specification of PUBLIC_PACKAGES) {
  callableCount += validatePackage(specification, failures);
}

if (PUBLIC_PACKAGES.length === 0) failures.push('no public packages were discovered');
if (callableCount === 0) failures.push('no public functions were resolved');

if (failures.length > 0) {
  console.error('Public API JSDoc validation failed:');
  for (const failure of failures.sort()) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Public API JSDoc validation passed (${callableCount} functions across ${PUBLIC_PACKAGES.length} packages).`,
  );
}
