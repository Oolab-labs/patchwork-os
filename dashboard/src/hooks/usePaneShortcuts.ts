"use client";
import { useEffect } from "react";

/**
 * Options controlling which keydown events {@link shouldIgnoreShortcutEvent}
 * treats as "not a shortcut" (i.e. should fall through to normal typing /
 * browser behavior).
 */
export interface ShortcutGuardOptions {
	/**
	 * Also ignore the event when Shift is held. Off by default — most
	 * single-key shortcuts (`/`, `?`, `E`, `X`) don't care about Shift
	 * (some even rely on it, e.g. `?` is Shift+/). The `j`/`k` row-nav
	 * shortcuts opt in via this flag so Shift+j/k doesn't hijack text
	 * selection extension.
	 */
	ignoreShift?: boolean;
}

/**
 * True when a keydown event should be ignored by a pane-level keyboard
 * shortcut: focus is inside an input/textarea/select/contenteditable, or
 * Cmd/Ctrl/Alt (and optionally Shift) is held.
 *
 * Shared guard extracted from the near-identical checks duplicated across
 * /recipes, /tasks, /runs, /approvals, and KeyboardShortcuts.
 */
export function shouldIgnoreShortcutEvent(
	e: KeyboardEvent,
	options?: ShortcutGuardOptions,
): boolean {
	if (e.metaKey || e.ctrlKey || e.altKey) return true;
	if (options?.ignoreShift && e.shiftKey) return true;
	const t = e.target as HTMLElement | null;
	if (t) {
		const tag = t.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) {
			return true;
		}
	}
	return false;
}

/**
 * Subscribes a `keydown` handler on `window` for the lifetime of the
 * effect, pre-filtered by {@link shouldIgnoreShortcutEvent}. `handler` is
 * only invoked for events that pass the guard.
 *
 * `deps` is the effect dependency array (same contract as `useEffect`) —
 * callers control when the listener is re-subscribed, matching the
 * per-site variations (e.g. /approvals re-subscribes on `filtered`,
 * `focusIndex`, `evidenceOpenedIds`).
 */
export function usePaneShortcut(
	handler: (e: KeyboardEvent) => void,
	deps: React.DependencyList,
	options?: ShortcutGuardOptions,
	// biome-ignore lint/correctness/useExhaustiveDependencies: deps is caller-controlled, mirroring useEffect's own contract.
): void {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (shouldIgnoreShortcutEvent(e, options)) return;
			handler(e);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps);
}
