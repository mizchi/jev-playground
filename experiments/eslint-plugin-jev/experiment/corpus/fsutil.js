import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJsonOrDefault(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export function loadConfig(path) {
  const raw = readJsonOrDefault(path, {});
  const merged = { retries: 3, timeout: 30000, verbose: false };
  for (const key of Object.keys(raw)) {
    merged[key] = raw[key];
  }
  return merged;
}

export function saveAll(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    try {
      writeFileSync(`${dir}/${name}`, body);
    } catch {
      // continue
    }
  }
}
