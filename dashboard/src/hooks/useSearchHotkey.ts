"use client";
import { useEffect, useRef } from "react";

/**
 * GitHub-style "/" hotkey that focuses the bound search input.
 *
 * Returns a ref to attach to the target input. While focused in another
 * input/textarea/contenteditable, or when Cmd/Ctrl/Alt are held, the key
 * is ignored — normal typing isn't hijacked and browser shortcuts still
 * fire.
 */
export function useSearchHotkey(): React.MutableRefObject<HTMLInputElement | null> {
	const ref = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
			const t = e.target as HTMLElement | null;
			if (t) {
				const tag = t.tagName;
				if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
			}
			if (!ref.current) return;
			e.preventDefault();
			ref.current.focus();
			ref.current.select();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	return ref;
}
