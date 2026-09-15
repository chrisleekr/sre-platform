import { hasKnownCredential, type TopologyCollection } from '@sre/contracts';

/** Validate bounded scan checkpoints before durable topology writes.
 * @param c - Provider-normalized collection and optional continuation inventory.
 */
export function validateTopologyScan(c: TopologyCollection): void {
  if (
    c.scan &&
    (typeof c.scan.incomplete !== 'boolean' ||
      (c.scan.cursor !== null &&
        (typeof c.scan.cursor !== 'string' || !c.scan.cursor || c.scan.cursor.length > 4096)) ||
      (c.completeness === 'complete' && (c.scan.cursor !== null || c.scan.incomplete)))
  )
    throw new Error('Invalid topology scan');
  const validIdentity = (value: unknown) =>
    typeof value === 'string' &&
    /^[a-zA-Z0-9._-]{1,253}$/.test(value) &&
    !hasKnownCredential(value);
  if (
    c.scan?.inventory !== undefined &&
    (!Array.isArray(c.scan.inventory) ||
      c.scan.inventory.length > 5000 ||
      c.scan.inventory.some(
        (item) =>
          !item ||
          !validIdentity(item.id) ||
          !validIdentity(item.name) ||
          (item.namespace !== undefined && !validIdentity(item.namespace)),
      ))
  )
    throw new Error('Invalid topology scan inventory');
}
