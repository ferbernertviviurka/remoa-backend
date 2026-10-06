// G21/F29 T6 (D-979): the in-process storage of the API cache (L1). The only file that knows where entries live:
// swapping to Redis (Q-071/Q-148) replaces this file (and makes get/set async in ./index.ts); catalog and callers stay.
// ponytail: one process, one Map. Correct only while the API runs with 1 replica (D-979); CACHE_DISABLED=1 or Redis to scale out.

type Entry = { value: unknown; expires: number; tags: readonly string[]; bytes: number };

/** LRU limits. One entry over MAX_ENTRY_BYTES is not stored at all (FR-36: no big payloads in cache). */
export const LIMITS = { entries: 5_000, bytes: 64 * 1024 * 1024, entryBytes: 512 * 1024 };

const entries = new Map<string, Entry>(); // insertion order = LRU order (a hit re-inserts)
const byTag = new Map<string, Set<string>>();
let bytes = 0;

function drop(key: string) {
  const e = entries.get(key);
  if (!e) return;
  entries.delete(key);
  bytes -= e.bytes;
  for (const t of e.tags) {
    const s = byTag.get(t);
    s?.delete(key);
    if (s?.size === 0) byTag.delete(t);
  }
}

/** 'hit' with the value, 'stale' (expired, now dropped) or 'miss'. */
export function get(key: string, now = Date.now()): { state: 'hit'; value: unknown } | { state: 'stale' | 'miss' } {
  const e = entries.get(key);
  if (!e) return { state: 'miss' };
  if (e.expires <= now) {
    drop(key);
    return { state: 'stale' };
  }
  entries.delete(key);
  entries.set(key, e);
  return { state: 'hit', value: e.value };
}

/** Stores a value for ttlMs under its tags. Returns false when the value is too big (or not serializable) to cache. */
export function set(key: string, value: unknown, ttlMs: number, tags: readonly string[], now = Date.now()): boolean {
  let size: number;
  try {
    size = (JSON.stringify(value) ?? '').length; // ponytail: chars as a byte estimate; fine for limits, not for accounting
  } catch {
    return false;
  }
  if (size > LIMITS.entryBytes) return false;
  drop(key);
  entries.set(key, { value, expires: now + ttlMs, tags, bytes: size });
  bytes += size;
  for (const t of tags) {
    let s = byTag.get(t);
    if (!s) byTag.set(t, (s = new Set()));
    s.add(key);
  }
  for (const k of entries.keys()) {
    if (entries.size <= LIMITS.entries && bytes <= LIMITS.bytes) break;
    drop(k); // oldest first
  }
  return true;
}

/** Drops every entry carrying any of the tags. Returns how many entries were dropped. */
export function deleteTags(tags: readonly string[]): number {
  let n = 0;
  for (const t of tags)
    for (const k of [...(byTag.get(t) ?? [])]) {
      if (!entries.has(k)) continue;
      drop(k);
      n++;
    }
  return n;
}

/** Tests and the internal route: drop everything. */
export function clear() {
  entries.clear();
  byTag.clear();
  bytes = 0;
}

export const size = () => ({ entries: entries.size, bytes });
