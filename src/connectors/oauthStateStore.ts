/**
 * Shared OAuth `state` parameter store for connector authorize→callback flows.
 *
 * Each connector previously kept its own module-scope `Set<string>` keyed by
 * a `setTimeout` cleanup. That works correctness-wise but is unbounded — a
 * loop of `/authorize` calls (10k requests in 10 min) would accumulate 10k
 * states + 10k pending timers, ~640 KB of heap that disappears 10 min later.
 * On a busy multi-tenant relay this becomes a memory amplification vector
 * any unauthenticated caller can drive.
 *
 * Defenses:
 *   - Hard cap (default 1000 entries) — when full, new `add()` calls return
 *     false and the caller surfaces an HTTP 429 / generic error.
 *   - TTL eviction at access time (consume() or add()) — no per-state timer,
 *     so 10k states cost 10k Map slots + 10k longs, nothing more.
 *   - `consume()` is single-use; second call with the same state returns false.
 *
 * Persistence (opt-in via `namespace`):
 *   - When `namespace` is set, the state map is mirrored to disk at
 *     `${PATCHWORK_HOME}/tokens/oauth-state.<namespace>.json` (mode 0600).
 *   - The in-memory Map remains the read path; disk is the source of truth
 *     so a bridge restart between /authorize and /callback survives.
 *   - Each mutation triggers an atomic re-serialise of the namespace's map
 *     via `writeFileAtomicSync` (sibling tmp + rename). State payloads are
 *     short-lived (≤10 min) and bounded (≤1000 entries × ~80 bytes each),
 *     so a full-rewrite-on-mutation is the simplest correct shape.
 *   - State values are CSRF nonces, NOT secrets — they're single-use and
 *     useless after consume(). Plain JSON storage at 0600 is sufficient;
 *     no need to encrypt under the master key like tokenStorage.ts does.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { writeFileAtomicSync } from "../writeFileAtomic.js";

export interface OAuthStateStore {
  /** Returns false if the cap is hit. */
  add(state: string): boolean;
  /** Consume on callback. Returns true if the state was valid and unconsumed. */
  consume(state: string): boolean;
  /** For tests. */
  size(): number;
}

interface Options {
  ttlMs?: number;
  maxEntries?: number;
  /**
   * When set, persist the state map to
   * `${PATCHWORK_HOME}/tokens/oauth-state.<namespace>.json`. Different
   * connectors must use distinct namespaces. When unset, the store is
   * memory-only (back-compat for tests).
   */
  namespace?: string;
}

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 1000;

function getStorageDir(): string {
  const base = process.env.PATCHWORK_HOME ?? join(os.homedir(), ".patchwork");
  return join(base, "tokens");
}

function stateFilePath(namespace: string): string {
  return join(getStorageDir(), `oauth-state.${namespace}.json`);
}

function loadFromDisk(namespace: string): Map<string, number> {
  const m = new Map<string, number>();
  const file = stateFilePath(namespace);
  if (!existsSync(file)) return m;
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const now = Date.now();
      // Use Object.hasOwn to avoid walking the prototype chain — same
      // pattern as the rest of the codebase (see Record<string,T>
      // prototype-walk feedback).
      for (const key of Object.keys(parsed)) {
        if (!Object.hasOwn(parsed as object, key)) continue;
        const expiry = (parsed as Record<string, unknown>)[key];
        if (typeof expiry === "number" && expiry >= now) {
          m.set(key, expiry);
        }
      }
    }
  } catch {
    // Corrupt file → start empty. Next mutation rewrites it.
  }
  return m;
}

function persistToDisk(namespace: string, states: Map<string, number>): void {
  const dir = getStorageDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const obj: Record<string, number> = {};
  for (const [k, v] of states) obj[k] = v;
  writeFileAtomicSync(stateFilePath(namespace), JSON.stringify(obj), {
    mode: 0o600,
  });
}

export function createOAuthStateStore(opts: Options = {}): OAuthStateStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const namespace = opts.namespace;
  const persist = typeof namespace === "string" && namespace.length > 0;

  // Read-through cache. Seeded from disk on construction so a bridge
  // restart preserves in-flight OAuth states.
  const states: Map<string, number> = persist
    ? loadFromDisk(namespace as string)
    : new Map<string, number>();

  function pruneExpired(now: number): boolean {
    let changed = false;
    for (const [s, expiry] of states) {
      if (expiry < now) {
        states.delete(s);
        changed = true;
      }
    }
    return changed;
  }

  function flush(): void {
    if (!persist) return;
    try {
      persistToDisk(namespace as string, states);
    } catch {
      // Disk failure is non-fatal — the in-memory store still works for
      // the lifetime of this process. A restart loses the unflushed state.
    }
  }

  return {
    add(state: string): boolean {
      const now = Date.now();
      const prunedSomething = pruneExpired(now);
      if (states.size >= maxEntries) {
        if (prunedSomething) flush();
        return false;
      }
      states.set(state, now + ttlMs);
      flush();
      return true;
    },
    consume(state: string): boolean {
      const now = Date.now();
      const expiry = states.get(state);
      if (expiry === undefined) return false;
      states.delete(state);
      flush();
      return expiry >= now;
    },
    size(): number {
      return states.size;
    },
  };
}
