/**
 * Terminal dashboard — `patchwork-os` with no args.
 *
 * Polls ~/.patchwork/runs.jsonl (recent recipe activity) and inbox/ (pending
 * items). Renders to stdout with ANSI color. Supports TTY and non-TTY output.
 *
 * Keybindings (TTY only):
 *   q / Ctrl-C  quit
 *   r           refresh now
 *   o <n>       open inbox item n in $EDITOR
 *   a <n>       approve inbox item (move to ~/.patchwork/approved/)
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export interface RunEntry {
  seq: number;
  recipeName?: string;
  trigger?: string;
  status: "done" | "error" | "running" | "pending" | string;
  createdAt?: number;
  doneAt?: number;
  durationMs?: number;
  outputTail?: string;
}

export interface InboxItem {
  index: number;
  filename: string;
  fullPath: string;
  mtime: number;
  preview: string;
}

export interface DashboardData {
  version: string;
  recipeCount: number;
  recentRuns: RunEntry[];
  inboxItems: InboxItem[];
}

export interface DashboardDeps {
  patchworkDir?: string;
  now?: () => Date;
  stdout?: NodeJS.WriteStream;
  /** Override for tests — skip TTY interaction. */
  noTTY?: boolean;
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const ESC = "\x1b[";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const BLUE = "\x1b[34m";

function color(c: string, s: string): string {
  return `${c}${s}${RESET}`;
}

function clearScreen(out: NodeJS.WriteStream): void {
  if (out.isTTY) {
    out.write(`${ESC}2J${ESC}H`);
  }
}

// ── Data loading ──────────────────────────────────────────────────────────────

export function loadRecentRuns(patchworkDir: string, limit = 10): RunEntry[] {
  const runsPath = path.join(patchworkDir, "runs.jsonl");
  if (!existsSync(runsPath)) return [];
  try {
    const lines = readFileSync(runsPath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit * 2);
    const entries: RunEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as RunEntry);
      } catch {
        // skip malformed
      }
    }
    return entries.slice(-limit).reverse();
  } catch {
    return [];
  }
}

export function loadInboxItems(patchworkDir: string, limit = 20): InboxItem[] {
  const inboxDir = path.join(patchworkDir, "inbox");
  if (!existsSync(inboxDir)) return [];
  try {
    const files = readdirSync(inboxDir)
      .filter((f) => !f.startsWith("."))
      .map((f) => {
        const fp = path.join(inboxDir, f);
        try {
          const st = statSync(fp);
          return { f, mtime: st.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { f: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);

    return files.map(({ f, mtime }, i) => {
      const fp = path.join(inboxDir, f);
      let preview = "";
      try {
        preview = readFileSync(fp, "utf-8")
          .split("\n")
          .slice(0, 3)
          .join(" ")
          .slice(0, 120);
      } catch {
        preview = "(unreadable)";
      }
      return { index: i + 1, filename: f, fullPath: fp, mtime, preview };
    });
  } catch {
    return [];
  }
}

export function countRecipes(patchworkDir: string): number {
  const recipesDir = path.join(patchworkDir, "recipes");
  if (!existsSync(recipesDir)) return 0;
  try {
    return readdirSync(recipesDir).filter(
      (f) =>
        (f.endsWith(".yaml") || f.endsWith(".yml") || f.endsWith(".json")) &&
        !f.endsWith(".permissions.json"),
    ).length;
  } catch {
    return 0;
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function formatAge(ms: number, now: number): string {
  const diff = Math.floor((now - ms) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function statusBadge(status: string): string {
  switch (status) {
    case "done":
      return color(GREEN, "✓ done");
    case "error":
      return color(RED, "✗ error");
    case "running":
      return color(YELLOW, "⟳ running");
    default:
      return color(DIM, status);
  }
}

export function renderDashboard(data: DashboardData, now: Date): string {
  const nowMs = now.getTime();
  const lines: string[] = [];

  // Header
  lines.push(
    `${BOLD}${BLUE}Patchwork OS${RESET}  ${DIM}v${data.version}${RESET}  •  ${color(CYAN, String(data.recipeCount))} recipes active`,
  );
  lines.push("");

  // Recent activity
  lines.push(color(BOLD, "RECENT (last 10 runs)"));
  if (data.recentRuns.length === 0) {
    lines.push(
      `  ${DIM}No runs yet. Try: patchwork-os recipe run ambient-journal${RESET}`,
    );
  } else {
    for (const run of data.recentRuns) {
      const ts = run.createdAt ? `[${formatAge(run.createdAt, nowMs)}]` : "";
      const name = run.recipeName ?? run.trigger ?? "unknown";
      const badge = statusBadge(run.status);
      const dur = run.durationMs
        ? ` (${(run.durationMs / 1000).toFixed(1)}s)`
        : "";
      const tail = run.outputTail
        ? `  ${DIM}→ ${run.outputTail.split("\n")[0]?.slice(0, 80)}${RESET}`
        : "";
      lines.push(
        `  ${DIM}${ts.padEnd(10)}${RESET}  ${color(CYAN, name).padEnd(30)}  ${badge}${dur}${tail}`,
      );
    }
  }
  lines.push("");

  // Inbox
  lines.push(color(BOLD, `INBOX (${data.inboxItems.length} pending approval)`));
  if (data.inboxItems.length === 0) {
    lines.push(`  ${DIM}Empty${RESET}`);
  } else {
    for (const item of data.inboxItems) {
      const age = formatAge(item.mtime, nowMs);
      lines.push(
        `  ${color(YELLOW, String(item.index).padStart(2))}  ${item.filename.padEnd(40)}  ${DIM}${age}${RESET}`,
      );
      if (item.preview) {
        lines.push(`      ${DIM}${item.preview}${RESET}`);
      }
    }
  }
  lines.push("");

  return lines.join("\n");
}

function renderHelp(isTTY: boolean): string {
  if (!isTTY) return "";
  return `${DIM}  q quit   r refresh   o <n> open in $EDITOR   a <n> approve${RESET}\n`;
}

// ── Approve / open helpers ────────────────────────────────────────────────────

function approveItem(item: InboxItem, patchworkDir: string): string {
  const approvedDir = path.join(patchworkDir, "approved");
  mkdirSync(approvedDir, { recursive: true });
  const dest = path.join(approvedDir, item.filename);
  renameSync(item.fullPath, dest);
  return `  ✓ moved to approved/${item.filename}`;
}

function openInEditor(item: InboxItem): void {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  const { spawnSync } = require("node:child_process");
  spawnSync(editor, [item.fullPath], { stdio: "inherit" });
}

// ── Main loop ─────────────────────────────────────────────────────────────────

export async function runDashboard(deps: DashboardDeps = {}): Promise<void> {
  const patchworkDir =
    deps.patchworkDir ?? path.join(os.homedir(), ".patchwork");
  const out = deps.stdout ?? process.stdout;
  const isTTY = !deps.noTTY && out.isTTY === true;
  const getNow = deps.now ?? (() => new Date());

  // Read version from package.json
  let version = "0.2.0";
  try {
    const pkg = JSON.parse(
      readFileSync(
        path.join(
          path.dirname(path.dirname(new URL(import.meta.url).pathname)),
          "package.json",
        ),
        "utf-8",
      ),
    ) as { version: string };
    version = pkg.version;
  } catch {
    // fallback
  }

  function getData(): DashboardData {
    return {
      version,
      recipeCount: countRecipes(patchworkDir),
      recentRuns: loadRecentRuns(patchworkDir),
      inboxItems: loadInboxItems(patchworkDir),
    };
  }

  function refresh(): void {
    if (isTTY) clearScreen(out);
    const data = getData();
    out.write(renderDashboard(data, getNow()));
    out.write(renderHelp(isTTY));
    if (!isTTY) {
      // Non-TTY: print once and exit
      process.exit(0);
    }
  }

  if (!isTTY) {
    refresh();
    return;
  }

  // TTY interactive mode
  refresh();
  const pollInterval = setInterval(refresh, 5_000);

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  let inputBuffer = "";

  function handleKey(str: string, key: readline.Key): void {
    if (key?.ctrl && key.name === "c") {
      cleanup();
      return;
    }
    const ch = str ?? "";

    if (ch === "q") {
      cleanup();
      return;
    }
    if (ch === "r") {
      refresh();
      inputBuffer = "";
      return;
    }
    if (ch === "\r" || ch === "\n") {
      const parts = inputBuffer.trim().split(/\s+/);
      const cmd = parts[0]?.toLowerCase();
      const idx = Number(parts[1]);
      inputBuffer = "";
      if ((cmd === "o" || cmd === "a") && Number.isFinite(idx) && idx > 0) {
        const data = getData();
        const item = data.inboxItems.find((x) => x.index === idx);
        if (!item) {
          out.write(`\n  Item ${idx} not found.\n`);
          return;
        }
        if (cmd === "o") {
          cleanup(false);
          openInEditor(item);
          // Re-enter dashboard after editor exits
          if (process.stdin.isTTY) process.stdin.setRawMode(true);
          refresh();
          const newInterval = setInterval(refresh, 5_000);
          process.stdin.on("keypress", handleKey);
          process.once("SIGINT", () => {
            clearInterval(newInterval);
            process.exit(0);
          });
          return;
        }
        if (cmd === "a") {
          const msg = approveItem(item, patchworkDir);
          out.write(`\n${msg}\n`);
          setTimeout(refresh, 200);
          return;
        }
      }
      return;
    }

    // Accumulate input for multi-char commands like "o 2"
    if (/[\w\s]/.test(ch)) {
      inputBuffer += ch;
      out.write(ch);
    }
  }

  process.stdin.on("keypress", handleKey);
  process.once("SIGINT", cleanup);

  function cleanup(doExit = true): void {
    clearInterval(pollInterval);
    process.stdin.removeListener("keypress", handleKey);
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
    out.write("\n");
    if (doExit) process.exit(0);
  }

  // Keep process alive
  await new Promise<void>(() => {});
}
