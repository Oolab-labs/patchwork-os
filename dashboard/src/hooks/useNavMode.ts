"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Simple/Advanced sidebar mode, persisted in localStorage.
 *
 * Default resolution (once, on first mount, since it needs `window`):
 *   - An explicit stored preference always wins.
 *   - Otherwise: if this browser has ANY other `patchwork.*` localStorage
 *     key already set (theme choice, a dismissed hint card, etc.), it's
 *     an existing install — default to Advanced (today's full sidebar,
 *     so nobody's nav silently changes under them).
 *   - A totally empty localStorage means a first-run browser — default
 *     to Simple.
 */

export type NavMode = "simple" | "advanced";

const STORAGE_KEY = "patchwork.navMode";
const PATCHWORK_KEY_PREFIX = "patchwork.";
// Pre-existing keys from before the `patchwork.` prefix convention was
// adopted — still valid "this browser has used the dashboard" signals.
const LEGACY_RETURNING_USER_KEYS = ["pw-theme"];

function hasReturningUserSignal(): boolean {
  try {
    for (const key of LEGACY_RETURNING_USER_KEYS) {
      if (window.localStorage.getItem(key) !== null) return true;
    }
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k !== STORAGE_KEY && k.startsWith(PATCHWORK_KEY_PREFIX)) {
        return true;
      }
    }
  } catch {
    // Private mode / storage disabled — treat as returning user so we
    // never surprise-narrow an existing user's nav due to a storage error.
    return true;
  }
  return false;
}

function readStoredMode(): NavMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "simple" || stored === "advanced") return stored;
  } catch {
    return "advanced";
  }
  return hasReturningUserSignal() ? "advanced" : "simple";
}

function writeStoredMode(mode: NavMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // private mode / quota — mode still applies for this session
  }
  writeModeCookie(mode);
}

/**
 * Mirror the mode into a cookie. localStorage is invisible to Next middleware,
 * and Simple mode has to be known BEFORE the first paint — a client-side
 * redirect would render the dense Overview and then bounce, showing the user
 * exactly the page they opted out of.
 *
 * Not a security boundary and never read as one: it only decides which of two
 * pages a GET lands on. SameSite=Lax so a cross-site navigation still carries
 * it (that IS the fresh-landing case), and no `secure` flag because the
 * dashboard is routinely served over plain http on localhost.
 */
function writeModeCookie(mode: NavMode): void {
  try {
    const oneYear = 60 * 60 * 24 * 365;
    document.cookie = `${STORAGE_KEY}=${mode}; path=/; max-age=${oneYear}; samesite=lax`;
  } catch {
    // No document (SSR) or cookies disabled — the sidebar still works from
    // localStorage; only the landing redirect degrades, back to today's
    // behaviour of always landing on Overview.
  }
}

/**
 * Returns [mode, setMode]. Starts as "advanced" during SSR/first paint
 * (matches existing installs, the common case) and resolves the real
 * value in an effect once `window` is available — same pattern as
 * Shell's `useTheme`.
 */
export function useNavMode(): [NavMode, (mode: NavMode) => void] {
  const [mode, setModeState] = useState<NavMode>("advanced");

  useEffect(() => {
    const resolved = readStoredMode();
    setModeState(resolved);
    // Seed the cookie for users whose mode predates it (or who default to
    // simple on a first-run browser) — otherwise the landing redirect would
    // only ever work for people who toggled the switch after this shipped.
    writeModeCookie(resolved);
  }, []);

  const setMode = useCallback((next: NavMode) => {
    setModeState(next);
    writeStoredMode(next);
  }, []);

  return [mode, setMode];
}
