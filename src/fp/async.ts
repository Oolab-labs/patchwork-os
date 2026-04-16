/**
 * Shared async helpers for the bridge FP layer.
 *
 * longPoll — eliminates duplicated long-poll boilerplate across watchDiagnostics
 * and any future long-poll tools. Handles:
 *   - signal already aborted on entry (fast-path)
 *   - timeout-first initialisation so cleanup() is always safe
 *   - TOCTOU re-check after subscription to close the change-window race
 *   - cleanup on all settle paths (timeout, abort, change, TOCTOU)
 */

/**
 * traverse<A, B>(items, f) — like Promise.all but preserves per-item errors
 * instead of short-circuiting.
 *
 * Returns an array of `{ ok: true; value: B } | { ok: false; error: string }`
 * for each item in `items`, in order.  Rejections are captured as `ok: false`
 * rather than propagating.  This mirrors Haskell's `traverse` semantics over
 * the `Either` applicative: every element is attempted independently.
 */
export type TraverseResult<B> =
  | { ok: true; value: B }
  | { ok: false; error: string };

export async function traverse<A, B>(
  items: A[],
  f: (item: A) => Promise<B>,
): Promise<TraverseResult<B>[]> {
  const settled = await Promise.allSettled(items.map(f));
  return settled.map((r) =>
    r.status === "fulfilled"
      ? { ok: true, value: r.value }
      : {
          ok: false,
          error:
            r.reason instanceof Error ? r.reason.message : String(r.reason),
        },
  );
}

export interface LongPollOptions<T> {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Return the current snapshot value synchronously. Called after settling. */
  getSnapshot: () => T;
  /**
   * Register a change listener. Called once before TOCTOU re-check.
   * Returns an unsubscribe function.
   */
  subscribe: (onChange: () => void) => () => void;
  /**
   * TOCTOU guard: called after subscription to detect changes that landed
   * between the initial pre-subscribe check and listener registration.
   * Return true → settle immediately as changed.
   */
  hasChanged: () => boolean;
}

export async function longPoll<T>(
  opts: LongPollOptions<T>,
): Promise<{ changed: boolean; value: T }> {
  const { timeoutMs, signal, getSnapshot, subscribe, hasChanged } = opts;

  // Fast-path: signal already aborted before we enter.
  if (signal?.aborted) {
    return { changed: false, value: getSnapshot() };
  }

  return new Promise<{ changed: boolean; value: T }>((resolve) => {
    let settled = false;

    // Declare all cleanup refs before any listener registration so cleanup()
    // is always safe to call regardless of how far initialisation got.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (abortHandler !== undefined)
        signal?.removeEventListener("abort", abortHandler);
      unsubscribe?.();
    };

    const settle = (changed: boolean): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ changed, value: getSnapshot() });
    };

    // Step 1: timeout first — cleanup() is valid from this point on.
    timer = setTimeout(() => settle(false), timeoutMs);

    // Step 2: abort handler.
    abortHandler = () => settle(false);
    signal?.addEventListener("abort", abortHandler);

    // Step 3: subscribe.
    unsubscribe = subscribe(() => settle(true));

    // Step 4: TOCTOU re-check — must be AFTER subscription.
    if (hasChanged()) {
      settle(true);
    }
  });
}
