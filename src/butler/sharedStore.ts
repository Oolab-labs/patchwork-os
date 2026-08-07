/**
 * The one `ButlerFactStore` a bridge process uses.
 *
 * Two surfaces now write facts — the MCP tools (`src/tools/butlerMemory.ts`)
 * and the HTTP routes (`src/butlerRoutes.ts`) — and each constructing its own
 * store would be actively wrong, not merely wasteful. `seq` is a per-instance
 * counter seeded from the file at construction; two instances in one process
 * would each hand out the same next number, and `resolve.ts` breaks ties on
 * `seq`. Two contradictory beliefs sharing a seq is a coin flip decided by
 * insertion order, in the store whose entire premise is that resolution is
 * deterministic.
 *
 * This does NOT fix the cross-PROCESS case (two bridges sharing $HOME can
 * still collide on seq — a known defect, tracked separately). It fixes the
 * one this file's callers control.
 */

import { ButlerFactStore, type FactStoreOptions } from "./factStore.js";

let store: ButlerFactStore | undefined;

/** The process-wide fact store, constructed on first use. */
export function getButlerFactStore(opts?: FactStoreOptions): ButlerFactStore {
  if (!store) store = new ButlerFactStore(opts);
  return store;
}

/**
 * Test seam. Drops the singleton so the next `getButlerFactStore` builds a
 * fresh one — needed because tests point the store at a temp dir per case.
 */
export function _resetButlerFactStoreForTests(): void {
  store = undefined;
}
