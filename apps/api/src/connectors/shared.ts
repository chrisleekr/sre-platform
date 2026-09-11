import type { Tx } from '@sre/db';
import { sql } from 'drizzle-orm';

export function requestObject(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

export async function lockConnectorLifecycle(
  tx: Tx,
  tenantId: string,
  connectorId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${connectorId}))`,
  );
}

export function dataSourceName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  return value &&
    value.length <= 80 &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 0x20)
    ? value
    : null;
}

export function defaultDataSourceName(type: string): string {
  if (type === 'argocd') return 'Argo CD';
  if (type === 'github') return 'GitHub';
  if (type === 'gitlab') return 'GitLab';
  if (type === 'statuscake') return 'StatusCake';
  if (type === 'networkprobe') return 'Network probe';
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export function connectorInstanceId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
    ? value
    : null;
}

export function kubernetesAccessId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  return /^[0-9a-f]{8}$/.test(value) ? value : null;
}

export function isUniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === '23505') return true;
    if (candidate.cause === current) return false;
    current = candidate.cause;
  }
  return false;
}

export function positiveId(input: unknown): string | null {
  if (typeof input === 'number' && Number.isSafeInteger(input) && input > 0) return String(input);
  if (typeof input !== 'string' || !/^\d+$/.test(input.trim()) || input.trim() === '0') return null;
  return input.trim();
}

export function githubAppId(input: unknown): string | null {
  if (typeof input === 'number' && Number.isSafeInteger(input) && input > 0) return String(input);
  if (typeof input !== 'string') return null;
  const value = input.trim();
  return value.length > 0 && value.length <= 255 ? value : null;
}

export function smeeUrlInput(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  try {
    const url = new URL(input.trim());
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'smee.io' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function gitLabSigningTokenInput(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (!value.startsWith('whsec_')) return null;
  try {
    return Buffer.from(value.slice('whsec_'.length), 'base64').byteLength === 32 ? value : null;
  } catch {
    return null;
  }
}
