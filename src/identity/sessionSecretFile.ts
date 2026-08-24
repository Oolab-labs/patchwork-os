/**
 * Read `DASHBOARD_SESSION_SECRET` out of `$PATCHWORK_HOME/.env` — the file
 * `patchwork init` writes and the bridge never read.
 *
 * ## Why this module exists at all
 *
 * ADR-0020 attribution shipped and was unreachable on most launch paths. The
 * dotenv loader in `src/index.ts` builds its candidates from `import.meta.url`,
 * so it reads `<install-dir>/.env` — a path `npm run install:global` destroys
 * on every reinstall — and never `$PATCHWORK_HOME/.env`. Measured on the live
 * machine 2026-08-24: all three running bridges lacked the variable while the
 * secret sat correctly on disk, so every approval they recorded was
 * unattributed despite the operator having done exactly the right setup.
 *
 * `scripts/start-all.sh --no-tmux` is the one path that works, and only because
 * it sources the file into the shell before launching. launchd, the tmux path
 * and a bare `patchwork start` all leave attribution off.
 *
 * ## Why it reads ONE key rather than loading the file
 *
 * `claudeDriver.ts:295` spawns agent subprocesses with `{ ...process.env }`.
 * Loading this file into the environment would hand `DASHBOARD_PASSWORD` and
 * whatever else it holds to every agent the bridge runs, in order to deliver
 * one unrelated value. So this returns the secret to its caller and writes
 * nothing to `process.env`.
 *
 * ## Why it is not in `dashboardSession.ts`
 *
 * That module is imported by the dashboard's Edge middleware
 * (`dashboard/src/lib/session.ts:43`), where `node:` imports are unavailable.
 * A `node:fs` import there breaks the dashboard build in middleware, which is
 * the one place a failure locks every user out. The read is Node-only, so it
 * lives here and is injected.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { patchworkHome } from "../patchworkHome.js";

const KEY = "DASHBOARD_SESSION_SECRET";

/**
 * Returns the secret, or `undefined` when the file, the key or the value is
 * absent.
 *
 * Fail-soft by construction: an unreadable or malformed file yields
 * `undefined`, which leaves attribution exactly where it was — off, with
 * decisions recorded unattributed. That is the pre-existing behaviour and the
 * correct one, since an absent actor already means "nobody recorded this" and
 * must never be filled in with a guess.
 */
export function readSessionSecretFromHome(dir?: string): string | undefined {
  const file = path.join(dir ?? patchworkHome(), ".env");
  if (!existsSync(file)) return undefined;

  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    // A commented-out key is not a key. Reading one would silently arm
    // attribution with a value the operator had deliberately disabled.
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq).trim() !== KEY) continue;

    // Quote handling mirrors the loader in `src/index.ts` so the same file
    // means the same thing to both readers. Deliberately does NOT strip inline
    // comments: a `#` inside a generated hex secret is not a comment, and
    // truncating a secret silently produces a value that verifies nothing.
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    return value === "" ? undefined : value;
  }
  return undefined;
}
