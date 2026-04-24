import { cookies } from "next/headers";

/** Server-side: true if demo mode is active (cookie overrides env var). */
export function isDemoModeServer(): boolean {
  try {
    const jar = cookies();
    const val = jar.get("pw-demo")?.value;
    if (val !== undefined) return val === "true";
  } catch {
    // cookies() throws outside request context (e.g. during build)
  }
  return process.env.NEXT_PUBLIC_DEMO_MODE === "true";
}
