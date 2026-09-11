import { z } from 'zod';

const AlertmanagerEventCredential = z.object({
  version: z.literal(1),
  token: z.string().min(16).max(4096),
  smeeUrl: z.string().url().optional(),
});

/**
 * Serializes authenticated Alertmanager delivery settings into a write-only credential.
 *
 * @param token - Bearer token required for inbound Alertmanager delivery.
 * @param smeeUrl - Optional development relay channel.
 */
export function alertmanagerEventCredential(token: string, smeeUrl?: string): string {
  return JSON.stringify(AlertmanagerEventCredential.parse({ version: 1, token, smeeUrl }));
}

function parse(value: string | null | undefined) {
  if (!value) return null;
  try {
    const result = AlertmanagerEventCredential.safeParse(JSON.parse(value));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Extracts the Alertmanager delivery token from a stored credential.
 *
 * @param value - Stored Alertmanager credential value.
 */
export const alertmanagerEventToken = (value: string | null | undefined): string | null =>
  parse(value)?.token ?? null;

/**
 * Extracts the optional Smee relay URL from a stored Alertmanager credential.
 *
 * @param value - Stored Alertmanager credential value.
 */
export const alertmanagerSmeeUrl = (value: string | null | undefined): string | null =>
  parse(value)?.smeeUrl ?? null;
