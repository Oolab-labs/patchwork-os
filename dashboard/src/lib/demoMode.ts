"use client";

const LS_KEY = "pw-demo";
const COOKIE = "pw-demo";
const EVENT = "pw-demo-change";

/** Client-side: true if demo mode is active. */
export function isDemoMode(): boolean {
  if (typeof window === "undefined") {
    return process.env.NEXT_PUBLIC_DEMO_MODE === "true";
  }
  const stored = localStorage.getItem(LS_KEY);
  if (stored !== null) return stored === "true";
  return process.env.NEXT_PUBLIC_DEMO_MODE === "true";
}

export function setDemoMode(on: boolean): void {
  localStorage.setItem(LS_KEY, String(on));
  // Set a cookie so server-side route handlers can read it
  document.cookie = `${COOKIE}=${on}; path=/; max-age=31536000; SameSite=Lax`;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: on }));
  window.location.reload();
}

export function onDemoModeChange(fn: (on: boolean) => void): () => void {
  const handler = (e: Event) => fn((e as CustomEvent<boolean>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
