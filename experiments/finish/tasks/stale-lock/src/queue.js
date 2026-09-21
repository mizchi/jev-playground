import { existsSync } from "node:fs";
import { resolve } from "node:path";

const LOCK = resolve(import.meta.dirname, "../.queue.lock");

/**
 * Drain the queue, refusing to run while another drain holds the lock.
 *
 * The lock is never checked for staleness, so a crashed run leaves the queue
 * permanently jammed.
 */
export function drain(items) {
  if (existsSync(LOCK)) throw new Error("another drain is in progress");
  return items.map((x) => x * 2);
}
