import { AdminMutationError } from '@sre/db';
import type { Context } from 'hono';
import type { z } from 'zod';
import type { AdminVariables } from './contracts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Parses a bounded administrator request body with one explicit schema. */
export async function adminBody<T extends z.ZodType>(
  c: Context<{ Variables: AdminVariables }>,
  schema: T,
): Promise<z.infer<T> | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

/** Maps stable repository refusals to explicit HTTP conflicts. */
export function adminMutationResponse(c: Context, error: unknown): Response | null {
  if (!(error instanceof AdminMutationError)) return null;
  if (error.code === 'forbidden') return c.json({ error: error.message }, 403);
  if (error.code === 'not_found') return c.json({ error: error.message }, 404);
  if (error.code === 'invalid_target') return c.json({ error: error.message }, 422);
  return c.json({ error: error.message, code: error.code }, 409);
}
