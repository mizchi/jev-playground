const store = new Map();

async function readRow(key) {
  await Promise.resolve();
  return store.get(key) ?? 0;
}

async function writeRow(key, value) {
  await Promise.resolve();
  store.set(key, value);
}

export async function increment(key) {
  const current = await readRow(key);
  await writeRow(key, current + 1);
  return current + 1;
}

export async function incrementAll(keys) {
  await Promise.all(keys.map((key) => increment(key)));
  return keys.length;
}

export function reset() {
  store.clear();
  return store.size;
}

export function snapshot() {
  const out = {};
  for (const [key, value] of store) out[key] = value;
  return out;
}
