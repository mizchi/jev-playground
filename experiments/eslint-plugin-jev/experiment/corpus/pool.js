export class Pool {
  constructor(size = 4) {
    this.free = Array.from({ length: size }, (_, i) => ({ id: i }));
    this.inUse = 0;
  }

  acquire() {
    const conn = this.free.pop();
    if (!conn) throw new Error("pool exhausted");
    this.inUse += 1;
    return conn;
  }

  release(conn) {
    this.inUse -= 1;
    this.free.push(conn);
  }
}

export function withConnection(pool, fn) {
  const conn = pool.acquire();
  const out = fn(conn);
  pool.release(conn);
  return out;
}

const settingsCache = new Map();

export function settingsFor(user) {
  if (settingsCache.has(user.id)) return settingsCache.get(user.id);
  const settings = { theme: user.theme, locale: user.locale };
  settingsCache.set(user.id, settings);
  return settings;
}

export function reachable(node) {
  const out = [node.id];
  for (const next of node.next) {
    out.push(...reachable(next));
  }
  return out;
}

export function describePool(pool) {
  return `${pool.inUse} in use, ${pool.free.length} free`;
}
