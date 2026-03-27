/**
 * Simple LRU (Least Recently Used) cache implementation.
 * Automatically evicts least recently used entry when size limit is reached.
 *
 * This provides bounded memory usage while preserving frequently accessed entries.
 */

export class LRUCache<K, V> {
  private cache = new Map<K, V>();
  private accessOrder: K[] = [];

  constructor(private readonly maxSize: number) {
    if (maxSize <= 0) {
      throw new Error("LRUCache maxSize must be greater than 0");
    }
  }

  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }

    // Move to end (most recently used)
    this.moveToEnd(key);
    return this.cache.get(key);
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      // Update existing entry - move to end
      this.moveToEnd(key);
      this.cache.set(key, value);
      return;
    }

    // Add new entry
    this.cache.set(key, value);
    this.accessOrder.push(key);

    // Evict oldest if over limit
    if (this.accessOrder.length > this.maxSize) {
      const oldest = this.accessOrder.shift();
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }

  delete(key: K): void {
    this.cache.delete(key);
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  get size(): number {
    return this.cache.size;
  }

  has(key: K): boolean {
    return this.cache.has(key);
  }

  keys(): K[] {
    return [...this.accessOrder];
  }

  /**
   * Move a key to the end of the access order (most recently used).
   */
  private moveToEnd(key: K): void {
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
      this.accessOrder.push(key);
    }
  }

  /**
   * Convert to Map for testing/compatibility.
   */
  toMap(): Map<K, V> {
    return new Map(this.cache);
  }
}
