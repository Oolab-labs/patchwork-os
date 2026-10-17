/**
 * Behind a base path (`/dashboard`), a raw `window.location.href = "/runs"`
 * or an absolute service-worker icon path leaves the app (audit M29). Next's
 * <Link>/router add the base path themselves; these did not.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
    if (statSync(full).isDirectory()) files(full, out);
    else if (/\.(tsx?|js)$/.test(name)) out.push(full);
  }
  return out;
}

describe("appHref", () => {
  it("applies the base path", async () => {
    vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/dashboard");
    vi.resetModules();
    const { appHref } = await import("@/lib/api");
    expect(appHref("/runs/7")).toBe("/dashboard/runs/7");
    vi.unstubAllEnvs();
  });
});

describe("no navigation or icon path skips the base path", () => {
  it("no `window.location.href = '/…'` or `= href` without appHref in src/", () => {
    const offenders = files(path.join(ROOT, "src")).flatMap((f) =>
      readFileSync(f, "utf-8")
        .split("\n")
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => !/^\s*(\*|\/\/)/.test(line))
        .filter(
          ({ line }) =>
            /window\.location\.(href|assign)\s*(=|\()\s*["'`]\//.test(line) ||
            /window\.location\.href\s*=\s*href\s*;/.test(line),
        )
        .map(({ i }) => `${path.relative(ROOT, f)}:${i + 1}`),
    );
    expect(offenders).toEqual([]);
  });

  it("service worker notification icons are scope-relative", () => {
    const sw = readFileSync(path.join(ROOT, "public", "sw.js"), "utf-8");
    expect(sw).not.toMatch(/(icon|badge):\s*["']\//);
  });
});
