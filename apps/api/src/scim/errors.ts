import type { Context } from 'hono';
import { SCIM_CONTENT_TYPE, SCIM_ERROR_SCHEMA } from './constants';

/** Returns one RFC-shaped SCIM error without exposing internal failure details. */
export function scimError(
  c: Context,
  status: 400 | 401 | 404 | 409 | 413 | 429 | 503,
  detail: string,
  scimType?: string,
) {
  return c.body(
    JSON.stringify({
      schemas: [SCIM_ERROR_SCHEMA],
      status: String(status),
      detail,
      ...(scimType ? { scimType } : {}),
    }),
    status,
    { 'Content-Type': SCIM_CONTENT_TYPE, 'Cache-Control': 'no-store' },
  );
}
