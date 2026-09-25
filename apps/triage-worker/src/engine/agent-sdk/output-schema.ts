import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod';

type SchemaNode = Record<string, unknown>;
const object = (value: unknown): value is SchemaNode =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const scalar = (value: unknown) =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

function retainDiscriminators(original: SchemaNode, transformed: SchemaNode): void {
  if (Object.hasOwn(original, 'const') && scalar(original.const))
    transformed.const = original.const;
  if (Array.isArray(original.enum) && original.enum.every(scalar)) transformed.enum = original.enum;
  for (const key of ['properties', '$defs', 'definitions']) {
    const source = original[key];
    const target = transformed[key];
    if (!object(source) || !object(target)) continue;
    for (const name of Object.keys(source)) {
      if (object(source[name]) && object(target[name]))
        retainDiscriminators(source[name], target[name]);
    }
  }
  if (object(original.items) && object(transformed.items))
    retainDiscriminators(original.items, transformed.items);
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const source = original[key];
    const target = transformed[key === 'oneOf' ? 'anyOf' : key];
    if (!Array.isArray(source) || !Array.isArray(target)) continue;
    for (const [index, node] of source.entries()) {
      if (object(node) && object(target[index])) retainDiscriminators(node, target[index]);
    }
  }
}

/** Preserve supported scalar discriminators while leaving unsupported bounds descriptive.
 * @param schema - Original local validator, also used after generation.
 */
export function agentSdkOutputSchema(schema: z.ZodType): SchemaNode {
  const transformed = zodOutputFormat(schema).schema;
  // Match the SDK's reference layout; referenced definitions are restored once, without expansion.
  retainDiscriminators(z.toJSONSchema(schema, { reused: 'ref' }), transformed);
  return transformed;
}
