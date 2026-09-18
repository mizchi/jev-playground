export class LruCache {
  constructor(max = 128) {
    this.max = max;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    return this.map.get(key);
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return this;
  }

  has(key) {
    return this.map.has(key);
  }

  get size() {
    return this.map.size;
  }
}

export function memoize(fn, max = 128) {
  const cache = new LruCache(max);
  return (arg) => {
    if (cache.has(arg)) return cache.get(arg);
    const value = fn(arg);
    cache.set(arg, value);
    return value;
  };
}
