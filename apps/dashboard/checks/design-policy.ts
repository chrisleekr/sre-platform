import ts from '@typescript/typescript6';

const RAW_COLOR = /#[\da-fA-F]{3,8}\b|(?:rgb|hsl)a?\(/;

export interface DesignViolation {
  line: number;
  rule: string;
  value: string;
}

/** Rejects static style drift without prescribing layout or changing component behaviour. */
export function inspectDesignPolicy(source: string): DesignViolation[] {
  const file = ts.createSourceFile(
    'view.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations: DesignViolation[] = [];
  const constants = new Map<string, ts.Expression>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer)
        constants.set(declaration.name.text, declaration.initializer);
    }
  }

  function fragments(node: ts.Node, seen = new Set<string>()): string[] {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      return [node.text];
    if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text))
      return fragments(constants.get(node.text)!, new Set([...seen, node.text]));
    const values: string[] = [];
    ts.forEachChild(node, (child) => {
      values.push(...fragments(child, seen));
    });
    return values;
  }

  function inspect(node: ts.Node) {
    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ['style', 'color', 'fill', 'stroke'].includes(node.name.getText(file))
    ) {
      for (const value of fragments(node.initializer)) {
        if (RAW_COLOR.test(value))
          violations.push({
            line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
            rule: 'Use semantic colour tokens in inline styles too',
            value,
          });
      }
    }
    if (ts.isJsxAttribute(node) && node.name.getText(file) === 'className' && node.initializer) {
      const element = node.parent.parent;
      const tag = element.tagName.getText(file);
      const classes = fragments(node.initializer).flatMap((value) => value.split(/\s+/));
      const control = ['button', 'input', 'textarea', 'select', 'NavLink'].includes(tag);
      const action = classes.includes('sre-action');
      const skipLink =
        tag === 'a' &&
        element.attributes.properties.some(
          (attribute) =>
            ts.isJsxAttribute(attribute) &&
            attribute.name.getText(file) === 'href' &&
            attribute.initializer &&
            ts.isStringLiteral(attribute.initializer) &&
            attribute.initializer.text === '#main-content',
        );
      const reject = (rule: string, value: string) =>
        violations.push({
          line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          rule,
          value,
        });
      for (const value of classes) {
        if (
          /(?:^|:)(?:bg|text|border|fill|stroke|ring|outline|decoration)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+)(?:\/|$)/.test(
            value,
          ) ||
          RAW_COLOR.test(value)
        )
          reject('Use semantic colour tokens', value);
        if (/(?:^|:)(?:drop-)?shadow(?:$|-(?!none(?:$|\s)))/.test(value))
          reject('Use surface tones and borders, not shadows', value);
        if (
          (control || action) &&
          /(?:^|:)rounded(?:-[trbl]{1,2})?-(?:lg|xl|2xl|3xl|full|\[)/.test(value)
        )
          reject('Controls must use the shared 4px radius', value);
        if (control && /(?:^|:)outline-(?:none|0)$/.test(value))
          reject('Keep keyboard focus visible', value);
        if (
          action &&
          /(?:^|:)(?:rounded(?:-|$)|p[xytrblse]?-(?:\d|\[)|disabled:opacity-|disabled:bg-)/.test(
            value,
          )
        )
          reject('Do not override shared action styling', value);
        if (
          action &&
          /(?:^|:)bg-/.test(value) &&
          value !== 'aria-pressed:bg-line' &&
          !(skipLink && value === 'bg-surface')
        )
          reject('Action backgrounds belong to the shared system', value);
      }
      if (classes.some((value) => /^sre-action-(primary|danger)$/.test(value)) && !action)
        reject('Action variants require sre-action', classes.join(' '));
    }
    ts.forEachChild(node, inspect);
  }
  inspect(file);
  return violations;
}
