"use client";

import { useEffect, useState } from "react";

// `beforeinstallprompt` is a non-standard but widely-supported event on
// Chromium browsers (Chrome, Edge, Brave, Android Chrome). Safari doesn't
// fire it — iOS users still install via Share → Add to Home Screen, and
// Safari hides the prompt entirely. We feature-detect and no-op elsewhere.
interface BeforeInstallPromptEvent extends Event {
	readonly platforms: string[];
	prompt(): Promise<void>;
	readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED_KEY = "patchwork:pwa-install-dismissed";

function isStandalone(): boolean {
	if (typeof window === "undefined") return false;
	// iOS Safari uses navigator.standalone; Chromium uses display-mode.
	if (window.matchMedia("(display-mode: standalone)").matches) return true;
	const nav = window.navigator as Navigator & { standalone?: boolean };
	return nav.standalone === true;
}

function wasDismissed(): boolean {
	if (typeof window === "undefined") return false;
	try {
		return window.localStorage.getItem(DISMISSED_KEY) === "1";
	} catch {
		return false;
	}
}

/**
 * One-time "Install Patchwork" prompt for Chromium browsers. Surfaces
 * the native `beforeinstallprompt` event as a small bottom-anchored
 * bar — install or dismiss-forever. No-ops on iOS Safari (event
 * unavailable; iOS install path is the Share menu).
 *
 * Persists dismissal in localStorage so we don't re-prompt on every
 * page load.
 */
export function PWAInstallPrompt() {
	const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
	const [visible, setVisible] = useState(false);

	useEffect(() => {
		if (isStandalone() || wasDismissed()) return;
		const onPrompt = (e: Event) => {
			e.preventDefault();
			setDeferred(e as BeforeInstallPromptEvent);
			setVisible(true);
		};
		const onInstalled = () => {
			setVisible(false);
			setDeferred(null);
		};
		window.addEventListener("beforeinstallprompt", onPrompt);
		window.addEventListener("appinstalled", onInstalled);
		return () => {
			window.removeEventListener("beforeinstallprompt", onPrompt);
			window.removeEventListener("appinstalled", onInstalled);
		};
	}, []);

	if (!visible || !deferred) return null;

	const onInstall = async () => {
		try {
			await deferred.prompt();
			await deferred.userChoice; // resolves once user picks
		} catch {
			// browser refused — fail silent
		} finally {
			setVisible(false);
			setDeferred(null);
		}
	};

	const onDismiss = () => {
		try {
			window.localStorage.setItem(DISMISSED_KEY, "1");
		} catch {
			/* private mode */
		}
		setVisible(false);
		setDeferred(null);
	};

	return (
		<div
			role="dialog"
			aria-label="Install Patchwork as an app"
			className="pwa-install-prompt"
		>
			<span className="pwa-install-prompt-text">
				Install Patchwork as an app for faster access + push notifications.
			</span>
			<button
				type="button"
				onClick={onDismiss}
				className="btn sm ghost"
				style={{ minHeight: 32 }}
			>
				Not now
			</button>
			<button
				type="button"
				onClick={onInstall}
				className="btn sm primary"
				style={{ minHeight: 32 }}
			>
				Install
			</button>
		</div>
	);
}
