import { z } from 'zod';
import type { DirectoryAccountInput } from '@sre/db';
import { SCIM_PATCH_SCHEMA, SCIM_USER_SCHEMA } from './constants';

const optionalText = z.string().trim().min(1).max(2_048).optional();
const name = z
  .object({
    formatted: optionalText,
    familyName: optionalText,
    givenName: optionalText,
    middleName: optionalText,
    honorificPrefix: optionalText,
    honorificSuffix: optionalText,
  })
  .strip();
const email = z
  .object({
    value: z.string().trim().min(1).max(320),
    type: z.string().trim().min(1).max(100).optional(),
    primary: z.boolean().optional(),
  })
  .strip();
const user = z
  .object({
    schemas: z.array(z.string()).min(1).max(10),
    externalId: z.string().trim().min(1).max(2_048).nullable().optional(),
    userName: z.string().trim().min(1).max(320),
    active: z.boolean().default(true),
    name: name.default({}),
    emails: z.array(email).max(50).default([]),
  })
  .passthrough();

const patch = z
  .object({
    schemas: z.array(z.string()).min(1).max(10),
    Operations: z
      .array(
        z
          .object({
            op: z.string().trim().min(1).max(20),
            path: z.string().trim().min(1).max(2_048).optional(),
            value: z.unknown().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();

function schemasAre(values: string[], required: string): boolean {
  return values.length === 1 && values[0]?.toLowerCase() === required.toLowerCase();
}

/** Validates and retains only the supported core SCIM User attributes. */
export function parseScimUser(value: unknown): DirectoryAccountInput | null {
  const result = user.safeParse(value);
  if (!result.success || !schemasAre(result.data.schemas, SCIM_USER_SCHEMA)) return null;
  return {
    externalId: result.data.externalId ?? null,
    userName: result.data.userName,
    active: result.data.active,
    name: result.data.name,
    emails: result.data.emails,
  };
}

type AttributeResult = { value: DirectoryAccountInput } | { error: 'invalidPath' | 'invalidValue' };

function setAttribute(
  current: DirectoryAccountInput,
  path: string,
  value: unknown,
): AttributeResult {
  const key = path.toLowerCase();
  if (key === 'username') {
    const parsed = z.string().trim().min(1).max(320).safeParse(value);
    return parsed.success
      ? { value: { ...current, userName: parsed.data } }
      : { error: 'invalidValue' };
  }
  if (key === 'externalid') {
    const parsed = z.string().trim().min(1).max(2_048).nullable().safeParse(value);
    return parsed.success
      ? { value: { ...current, externalId: parsed.data } }
      : { error: 'invalidValue' };
  }
  if (key === 'active') {
    return typeof value === 'boolean'
      ? { value: { ...current, active: value } }
      : { error: 'invalidValue' };
  }
  if (key === 'name') {
    const parsed = name.safeParse(value);
    return parsed.success
      ? { value: { ...current, name: parsed.data } }
      : { error: 'invalidValue' };
  }
  if (key === 'emails') {
    const parsed = z.array(email).max(50).safeParse(value);
    return parsed.success
      ? { value: { ...current, emails: parsed.data } }
      : { error: 'invalidValue' };
  }
  return { error: 'invalidPath' };
}

function applyObject(
  current: DirectoryAccountInput,
  value: unknown,
): AttributeResult | { error: 'invalidSyntax' } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'invalidSyntax' };
  }
  let next = current;
  for (const [key, entry] of Object.entries(value)) {
    const updated = setAttribute(next, key, entry);
    if ('error' in updated) return updated;
    next = updated.value;
  }
  return { value: next };
}

/** Applies the supported atomic SCIM PatchOp subset before any database mutation. */
export function applyScimPatch(
  current: DirectoryAccountInput,
  value: unknown,
): { value: DirectoryAccountInput } | { error: 'invalidSyntax' | 'invalidPath' | 'invalidValue' } {
  const result = patch.safeParse(value);
  if (!result.success || !schemasAre(result.data.schemas, SCIM_PATCH_SCHEMA)) {
    return { error: 'invalidSyntax' };
  }
  let next = current;
  for (const operation of result.data.Operations) {
    const op = operation.op.toLowerCase();
    if (!['add', 'replace', 'remove'].includes(op)) return { error: 'invalidSyntax' };
    if (op === 'remove') {
      const path = operation.path?.toLowerCase();
      if (path === 'externalid') next = { ...next, externalId: null };
      else if (path === 'name') next = { ...next, name: {} };
      else if (path === 'emails') next = { ...next, emails: [] };
      else return { error: 'invalidPath' };
      continue;
    }
    const updated = operation.path
      ? setAttribute(next, operation.path, operation.value)
      : applyObject(next, operation.value);
    if ('error' in updated) return updated;
    next = updated.value;
  }
  return { value: next };
}
