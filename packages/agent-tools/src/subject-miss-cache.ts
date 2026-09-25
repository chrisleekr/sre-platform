/** Process-local memory of subject-path misses: a URL that matched no single provider monitor, or
 * a notice whose matched monitor reported no episode it can bind.
 *
 * @remarks Reconciliation runs about every 30 seconds, and without this each pass would re-read the
 * provider for a notice that cannot bind. Only misses are kept: a match is re-selected on
 * every attempt, so a stale entry can at worst delay a binding by the TTL, never create one. Keys
 * include the connector generation, so a configuration change forgets earlier misses. The map is
 * bounded; inserting past the limit evicts the oldest entry.
 */
export class SubjectMissCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  /**
   * @param options - Entry lifetime, entry bound and the clock, injectable for tests.
   */
  constructor(
    private readonly options: { ttlMs: number; maxEntries: number; now?: () => number },
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    // Re-inserting moves the key to the newest position in Map iteration order.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.options.ttlMs });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
