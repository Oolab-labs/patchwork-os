import {
  ButlerOpenLoopStore,
  type OpenLoopStoreOptions,
} from "./openLoopStore.js";

let store: ButlerOpenLoopStore | undefined;

/** Process-wide Loose Ends store, built lazily on first route use. */
export function getButlerOpenLoopStore(
  opts?: OpenLoopStoreOptions,
): ButlerOpenLoopStore {
  if (!store) store = new ButlerOpenLoopStore(opts);
  return store;
}

/** Test seam. */
export function _resetButlerOpenLoopStoreForTests(): void {
  store = undefined;
}
