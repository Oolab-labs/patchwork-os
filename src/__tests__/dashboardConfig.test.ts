// DB-7: regression tests pinning DB-2 (apiPath helper / NEXT_PUBLIC_BASE_PATH wiring).
//
// Background: dashboard's Next.js app is mounted at basePath="/dashboard". A
// client-side `apiPath(path)` helper prepends basePath to fetch URLs so the
// bridge-proxy routes (`/api/bridge/*`) resolve. Without basePath, requests
// hit bare `/api/bridge/*` which 404s.
//
// DB-2 fix: inject `NEXT_PUBLIC_BASE_PATH` via `next.config.js`'s `env` block
// so the static replacement at build time matches `basePath`. If anyone drops
// the env block, removes the helper, or starts using bare fetches, these
// tests fail.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const DASHBOARD = join(REPO_ROOT, "dashboard");

const require_ = createRequire(import.meta.url);

describe("dashboard next.config.js — DB-2 regression", () => {
  test("basePath is /dashboard", () => {
    const cfg = require_(join(DASHBOARD, "next.config.js"));
    expect(cfg.basePath).toBe("/dashboard");
  });

  test("env.NEXT_PUBLIC_BASE_PATH matches basePath", () => {
    const cfg = require_(join(DASHBOARD, "next.config.js"));
    expect(cfg.env).toBeDefined();
    expect(cfg.env.NEXT_PUBLIC_BASE_PATH).toBe(cfg.basePath);
  });
});

describe("dashboard apiPath helper — DB-2 regression", () => {
  const apiSrc = readFileSync(join(DASHBOARD, "src/lib/api.ts"), "utf8");

  test("reads from NEXT_PUBLIC_BASE_PATH", () => {
    expect(apiSrc).toMatch(/process\.env\.NEXT_PUBLIC_BASE_PATH/);
  });

  test("falls back to empty string (so dev without env still works)", () => {
    expect(apiSrc).toMatch(/\?\?\s*""/);
  });

  test("exports apiPath function that prepends BASE", () => {
    expect(apiSrc).toMatch(/export function apiPath/);
    expect(apiSrc).toMatch(/\$\{BASE\}\$\{path\}/);
  });
});

describe("dashboard pages — no bare /api/bridge fetches", () => {
  // Walk dashboard/src/app + components/hooks. Anything fetching the bridge
  // proxy MUST go through `apiPath()`. Bare `fetch("/api/bridge/x")` was the
  // exact regression DB-2 fixed.
  const candidateDirs = [
    join(DASHBOARD, "src", "app"),
    join(DASHBOARD, "src", "components"),
    join(DASHBOARD, "src", "hooks"),
    join(DASHBOARD, "src", "lib"),
  ];

  function walk(dir: string): string[] {
    const fs = require_("node:fs") as typeof import("node:fs");
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(p));
      else if (/\.(tsx?|mts|cts)$/.test(entry.name)) out.push(p);
    }
    return out;
  }

  const files = candidateDirs.flatMap((d) => walk(d));

  // Rule: every `fetch(...)` or `new EventSource(...)` argument that is a
  // proxy URL literal must be wrapped in `apiPath(...)`. Catches the exact
  // class of regression DB-2 fixed: `fetch("/api/bridge/x")` 404s in prod
  // because basePath is `/dashboard` and the route is mounted at
  // `/dashboard/api/bridge/x`.
  //
  // Implementation: locate every `fetch(` / `new EventSource(` opener; read
  // the argument range up to the matching close paren or 5 lines (whichever
  // is shorter); if a proxy literal appears in that window without
  // `apiPath(`, flag it.
  //
  // Server-side route handlers under app/api/** legitimately reference these
  // paths as strings — we exclude any file that lives under `src/app/api/`.
  const offenders: { file: string; line: number; text: string }[] = [];
  const PROXY_LITERAL = /["`']\/api\/(?:bridge|inbox|push)\b/;
  const NETWORK_OPENER = /\b(?:await\s+fetch|fetch|new\s+EventSource)\s*\(/;

  for (const file of files) {
    if (file.includes(`${join("src", "app", "api")}`)) continue;
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, idx) => {
      if (!NETWORK_OPENER.test(line)) return;
      // Window: opener line + up to 4 continuation lines (covers multi-line
      // fetch(`...`, { ... }) calls where the URL is on its own line).
      const window = lines
        .slice(idx, Math.min(idx + 5, lines.length))
        .join("\n");
      if (!PROXY_LITERAL.test(window)) return;
      if (window.includes("apiPath(")) return;
      offenders.push({
        file: relative(REPO_ROOT, file),
        line: idx + 1,
        text: line.trim(),
      });
    });
  }

  test("no client-side fetch hits bare /api/bridge|/api/inbox|/api/push", () => {
    expect(offenders).toEqual([]);
  });

  test("at least one apiPath caller exists (sanity)", () => {
    let count = 0;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      count += (text.match(/\bapiPath\(/g) ?? []).length;
    }
    expect(count).toBeGreaterThan(20);
  });
});
