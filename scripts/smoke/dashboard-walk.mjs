#!/usr/bin/env node
/**
 * dashboard-walk.mjs — sidebar walk + bridge-proxy regression smoke for the
 * Next.js dashboard. Pings every sidebar route + the /api/bridge/status proxy
 * and asserts each returns a non-404 response (HTML page or JSON).
 *
 * Catches the class of regression DB-2 fixed: a misconfigured basePath /
 * NEXT_PUBLIC_BASE_PATH wiring that makes every API proxy 404.
 *
 * Usage:
 *   # against local dev server (npm run dev in dashboard/)
 *   node scripts/smoke/dashboard-walk.mjs
 *
 *   # against a deployed dashboard
 *   node scripts/smoke/dashboard-walk.mjs --url https://patchwork.example.com/dashboard
 *
 *   # bridge proxy on a different bridge port
 *   BRIDGE_URL=http://127.0.0.1:37210 node scripts/smoke/dashboard-walk.mjs
 *
 * Exits 0 on full pass, 1 on any failure.
 */

import { argv, env, exit } from "node:process";

// ── args ──────────────────────────────────────────────────────────────────────
function flag(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

const DEFAULT_BASE = "http://localhost:3200/dashboard";
const BASE = flag("--url", env.DASHBOARD_URL ?? DEFAULT_BASE).replace(
  /\/$/,
  "",
);
const TIMEOUT_MS = Number(flag("--timeout", env.SMOKE_TIMEOUT_MS ?? "5000"));

// Sidebar routes (mirror dashboard/src/components/Shell.tsx NAV_SECTIONS).
// The walk asserts each route returns a non-404 — content correctness is
// covered by per-page tests.
const SIDEBAR_ROUTES = [
  "/",
  "/inbox",
  "/approvals",
  "/activity",
  "/recipes",
  "/marketplace",
  "/tasks",
  "/runs",
  "/sessions",
  "/metrics",
  "/analytics",
  "/traces",
  "/decisions",
  "/connections",
  "/settings",
  "/recipes/new",
];

// API proxy routes that must reach the bridge (DB-2 regression surface).
const API_ROUTES = ["/api/bridge/status"];

// ── helpers ───────────────────────────────────────────────────────────────────
const RED = "\x1b[31m",
  GREEN = "\x1b[32m",
  DIM = "\x1b[2m",
  RESET = "\x1b[0m";

async function probe(path, expect = "html") {
  const url = `${BASE}${path}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "manual" });
    clearTimeout(timer);
    // Allow 2xx and 3xx (redirects to /dashboard from bare /). 404 is fail.
    if (res.status >= 400) {
      return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    }
    if (expect === "json" && res.status >= 200 && res.status < 300) {
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        return {
          ok: false,
          status: res.status,
          reason: `expected JSON, got ${ct}`,
        };
      }
    }
    return { ok: true, status: res.status };
  } catch (e) {
    clearTimeout(timer);
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, reason };
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
console.log(`${DIM}Dashboard smoke walk against ${BASE}${RESET}\n`);

let pass = 0,
  fail = 0;
const failures = [];

for (const route of SIDEBAR_ROUTES) {
  const r = await probe(route, "html");
  if (r.ok) {
    pass++;
    console.log(`  ${GREEN}✓${RESET} ${route}  ${DIM}${r.status}${RESET}`);
  } else {
    fail++;
    failures.push({ route, ...r });
    console.log(`  ${RED}✗${RESET} ${route}  ${RED}${r.reason}${RESET}`);
  }
}

console.log("");
for (const route of API_ROUTES) {
  const r = await probe(route, "json");
  if (r.ok) {
    pass++;
    console.log(`  ${GREEN}✓${RESET} ${route}  ${DIM}${r.status}${RESET}`);
  } else {
    fail++;
    failures.push({ route, ...r });
    console.log(`  ${RED}✗${RESET} ${route}  ${RED}${r.reason}${RESET}`);
  }
}

console.log("\n═══════════════════════════════════");
const total = pass + fail;
if (fail === 0) {
  console.log(`${GREEN}ALL PASS${RESET} (${pass}/${total} routes)`);
  exit(0);
} else {
  console.log(`${RED}FAILURES: ${fail}/${total}${RESET}`);
  for (const f of failures) console.log(`  ✗ ${f.route} → ${f.reason}`);
  exit(1);
}
