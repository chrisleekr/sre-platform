const MATERIAL_ROLE =
  /\b(?:cluster|commit|container|database|deployment|host|instance|job|namespace|node|pod|release|revision|rollout|service|sha|version|workload)\s*(?:=|:|#|is|was|to)?\s*[`"']?(?:[a-z][a-z0-9._/-]*|v?\d+(?:\.\d+)*|[0-9a-f]{7,})/gi;
const MATERIAL_TOKEN =
  /\b(?:[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)+|(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z][a-z0-9]+)\b/gi;

/**
 * Reduces free-form provider text to investigation material while retaining named operational scope.
 *
 * @param value - Provider-authored annotation or description text.
 */
export function semanticMaterialText(value: string): string {
  const held: string[] = [];
  const hold = (material: string): string => {
    held.push(material);
    return `\uE000${'x'.repeat(held.length)}\uE001`;
  };
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<dynamic>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<dynamic>')
    .replace(/\b\d{4}-\d{2}-\d{2}[t ][^\s]+/gi, '<dynamic>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, hold)
    .replace(MATERIAL_ROLE, hold)
    .replace(/\b[0-9a-f]{16,64}\b/gi, '<dynamic>')
    .replace(MATERIAL_TOKEN, hold)
    .replace(/\b\d+(?:\.\d+)?(?:e[+-]?\d+)?(?:%|[a-z]+)?\b/gi, '<dynamic>')
    .replace(/\uE000(x+)\uE001/g, (_match, index: string) => held[index.length - 1] ?? '<entity>')
    .replace(/\s+/g, ' ')
    .trim();
}
