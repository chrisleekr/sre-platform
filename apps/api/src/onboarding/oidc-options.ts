import { z } from 'zod';

/** OAuth request options needed to obtain an access token for the configured API. */
export const oidcRequestOptions = z.object({
  authorizationScopes: z
    .array(z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]{1,2048}$/))
    .max(20)
    .default([]),
  authorizationAudience: z.string().trim().max(2048).nullable().optional(),
});
