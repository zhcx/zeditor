/**
 * Small LRU cache with both an entry-count and a weight limit.
 *
 * Rendering caches hold generated HTML strings, so a plain entry limit is not
 * enough: a handful of very large code fences could otherwise retain hundreds
 * of megabytes. Weight is supplied by the caller (usually `value.length`), and
 * an entry larger than the whole budget is simply not cached.
 */
export class BoundedCache<K, V> {
  private readonly entries = new Map<K, V>();
  private readonly maxEntries: number;
  private readonly maxWeight: number;
  private readonly weigh: (value: V) => number;
  private totalWeight = 0;

  constructor(
    maxEntries: number,
    maxWeight = Number.POSITIVE_INFINITY,
    weigh: (value: V) => number = () => 1,
  ) {
    if (!Number.isFinite(maxEntries) && maxEntries !== Number.POSITIVE_INFINITY) {
      throw new RangeError('maxEntries must be a positive number');
    }
    if (maxEntries <= 0) throw new RangeError('maxEntries must be greater than zero');
    if (maxWeight < 0) throw new RangeError('maxWeight must not be negative');
    this.maxEntries = maxEntries;
    this.maxWeight = maxWeight;
    this.weigh = weigh;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Refresh recency so frequently used entries survive eviction.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    const weight = Math.max(0, this.weigh(value));
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.totalWeight -= Math.max(0, this.weigh(previous));
      this.entries.delete(key);
    }
    if (weight > this.maxWeight) return;
    this.entries.set(key, value);
    this.totalWeight += weight;
    while (this.entries.size > this.maxEntries || this.totalWeight > this.maxWeight) {
      const oldest = this.entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (evicted !== undefined) this.totalWeight -= Math.max(0, this.weigh(evicted));
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }
}
