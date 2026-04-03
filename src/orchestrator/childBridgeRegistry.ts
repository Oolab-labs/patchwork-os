import fs from "node:fs";
import path, { sep } from "node:path";
import type { ToolSchema } from "../transport.js";

// Edge case 3: IDEs known to write lock files without a bridge extension
const NON_BRIDGE_IDE_NAMES = new Set([
  "JetBrains",
  "IntelliJ IDEA",
  "PyCharm",
  "WebStorm",
  "GoLand",
  "Rider",
  "CLion",
  "RubyMine",
  "PhpStorm",
  "DataGrip",
]);

export interface ChildBridge {
  port: number;
  workspace: string;
  workspaceFolders: string[];
  ideName: string;
  authToken: string;
  pid: number;
  startedAt: number;
  healthy: boolean;
  lastCheckedAt: number;
  consecutiveFailures: number;
  tools: ToolSchema[];
  // Edge case 1: startup grace
  discoveredAt: number;
  warmingUp: boolean;
}

interface ValidatedLockData {
  pid: number;
  startedAt: number;
  workspace: string;
  workspaceFolders: string[];
  ideName: string;
  authToken: string;
}

interface InvalidLockData {
  invalid: true;
  reason: string;
}

/** Validate a raw lock file object against the required bridge field set. */
export function validateLockData(
  data: unknown,
): ValidatedLockData | InvalidLockData {
  if (typeof data !== "object" || data === null) {
    return { invalid: true, reason: "not an object" };
  }
  const d = data as Record<string, unknown>;

  if (d.orchestrator === true)
    return { invalid: true, reason: "orchestrator lock" };
  if (d.isBridge !== true)
    return { invalid: true, reason: "isBridge !== true" };

  if (typeof d.authToken !== "string" || d.authToken.length < 32) {
    return { invalid: true, reason: "missing or short authToken" };
  }
  if (typeof d.pid !== "number" || !Number.isInteger(d.pid) || d.pid <= 0) {
    return { invalid: true, reason: "invalid pid" };
  }
  if (typeof d.startedAt !== "number" || d.startedAt <= 0) {
    return { invalid: true, reason: "missing startedAt" };
  }
  if (!Array.isArray(d.workspaceFolders)) {
    return { invalid: true, reason: "workspaceFolders not an array" };
  }
  if (
    !d.workspaceFolders.every(
      (f) => typeof f === "string" && f.length > 1 && path.isAbsolute(f),
    )
  ) {
    return {
      invalid: true,
      reason: "workspaceFolders contains invalid entries",
    };
  }

  const ideName =
    typeof d.ideName === "string" && d.ideName.trim().length > 0
      ? d.ideName.trim()
      : null;
  if (!ideName) {
    return { invalid: true, reason: "missing ideName" };
  }
  if (NON_BRIDGE_IDE_NAMES.has(ideName)) {
    return { invalid: true, reason: `known non-bridge IDE: ${ideName}` };
  }

  // transport is optional but must be "ws" if present
  if (typeof d.transport === "string" && d.transport !== "ws") {
    return { invalid: true, reason: `unexpected transport: ${d.transport}` };
  }

  return {
    pid: d.pid as number,
    startedAt: d.startedAt as number,
    workspace:
      typeof d.workspace === "string"
        ? d.workspace
        : ((d.workspaceFolders as string[])[0] ?? ""),
    workspaceFolders: d.workspaceFolders as string[],
    ideName,
    authToken: d.authToken as string,
  };
}

export class ChildBridgeRegistry {
  private bridges = new Map<number, ChildBridge>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ownPort: number;
  /** Ports we've already logged a rejection for — avoid log spam on every scan. */
  private rejectedPorts = new Map<number, string>();

  constructor(
    private lockDir: string,
    private healthIntervalMs: number,
    ownPort: number,
  ) {
    this.ownPort = ownPort;
  }

  start(): void {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.healthIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.rejectedPorts.clear();
  }

  refresh(): void {
    let files: string[];
    try {
      files = fs.readdirSync(this.lockDir).filter((f) => f.endsWith(".lock"));
    } catch {
      return;
    }

    const seen = new Set<number>();

    for (const file of files) {
      const portStr = file.replace(".lock", "");
      const port = Number.parseInt(portStr, 10);
      if (
        !Number.isFinite(port) ||
        port < 1024 ||
        port > 65535 ||
        port === this.ownPort
      )
        continue;

      try {
        const stat = fs.lstatSync(path.join(this.lockDir, file));
        if (stat.isSymbolicLink() || stat.size > 4096) continue;

        const raw = fs.readFileSync(path.join(this.lockDir, file), "utf-8");
        const data = JSON.parse(raw) as unknown;
        const validated = validateLockData(data);

        if ("invalid" in validated) {
          // Log first occurrence; suppress repeats to avoid log spam
          if (!this.rejectedPorts.has(port)) {
            const isExpected =
              validated.reason === "orchestrator lock" ||
              validated.reason === "isBridge !== true" ||
              validated.reason.startsWith("known non-bridge IDE:");
            if (!isExpected) {
              // Unexpected — warn so operators notice misconfiguration
              // Strip non-printable chars to prevent log injection
              const safeReason = validated.reason.replace(/[^\x20-\x7E]/g, "?");
              const safeFile = file.replace(/[^\x20-\x7E]/g, "?");
              console.error(
                `[orchestrator] WARNING: skipping lock file ${safeFile}: ${safeReason}`,
              );
            }
            this.rejectedPorts.set(port, validated.reason);
          }
          continue;
        }

        // Clear rejection record if file becomes valid on a later scan
        this.rejectedPorts.delete(port);

        // Skip dead processes
        try {
          process.kill(validated.pid, 0);
        } catch {
          continue;
        }

        // Skip >24h old (PID reuse guard)
        if (Date.now() - validated.startedAt > 24 * 60 * 60 * 1000) {
          continue;
        }

        seen.add(port);

        if (!this.bridges.has(port)) {
          this.bridges.set(port, {
            port,
            workspace: validated.workspace,
            workspaceFolders: validated.workspaceFolders,
            ideName: validated.ideName,
            authToken: validated.authToken,
            pid: validated.pid,
            startedAt: validated.startedAt,
            healthy: false,
            lastCheckedAt: 0,
            consecutiveFailures: 0,
            tools: [],
            discoveredAt: Date.now(),
            warmingUp: true,
          });
        }
      } catch {
        // malformed lock — skip silently
      }
    }

    // Remove bridges whose lock files disappeared
    for (const port of this.bridges.keys()) {
      if (!seen.has(port)) {
        this.bridges.delete(port);
        // Allow re-logging if the port re-appears with a different lock later
        this.rejectedPorts.delete(port);
      }
    }
  }

  markHealthy(port: number, tools: ToolSchema[]): void {
    const b = this.bridges.get(port);
    if (!b) return;
    b.healthy = true;
    b.warmingUp = false;
    b.consecutiveFailures = 0;
    b.lastCheckedAt = Date.now();
    b.tools = tools;
  }

  markUnhealthy(port: number): void {
    const b = this.bridges.get(port);
    if (!b) return;
    b.healthy = false;
    b.lastCheckedAt = Date.now();
    // Edge case 1: don't count failures during the startup grace window
    if (!b.warmingUp) {
      b.consecutiveFailures++;
    }
  }

  /** Update lastCheckedAt without changing health state — used during warm-up. */
  keepWarm(port: number): void {
    const b = this.bridges.get(port);
    if (!b) return;
    b.lastCheckedAt = Date.now();
  }

  /** Clear warmingUp flag once the grace window expires (called by probeAll). */
  markWarm(port: number): void {
    const b = this.bridges.get(port);
    if (!b) return;
    b.warmingUp = false;
  }

  getAll(): ChildBridge[] {
    return Array.from(this.bridges.values());
  }

  getHealthy(): ChildBridge[] {
    return Array.from(this.bridges.values()).filter((b) => b.healthy);
  }

  getWarmingUp(): ChildBridge[] {
    return Array.from(this.bridges.values()).filter(
      (b) => !b.healthy && b.warmingUp,
    );
  }

  /** Pick the best bridge for a given workspace path (longest prefix match).
   *  Tie-breaking: prefer 0 consecutiveFailures, then most recently started. */
  pickForWorkspace(workspace: string): ChildBridge | null {
    let bestLen = -1;
    let tied: ChildBridge[] = [];

    for (const b of this.bridges.values()) {
      if (!b.healthy) continue;
      for (const folder of b.workspaceFolders) {
        if (
          workspace === folder ||
          (workspace.startsWith(folder) && workspace[folder.length] === sep)
        ) {
          if (folder.length > bestLen) {
            bestLen = folder.length;
            tied = [b];
          } else if (folder.length === bestLen) {
            tied.push(b);
          }
        }
      }
    }

    if (tied.length === 0) return null;
    if (tied.length === 1) return tied[0] ?? null;

    // Tie-break: prefer 0 failures, then most recently started
    return (
      tied.sort((a, b) => {
        if (a.consecutiveFailures !== b.consecutiveFailures) {
          return a.consecutiveFailures - b.consecutiveFailures;
        }
        return b.startedAt - a.startedAt;
      })[0] ?? null
    );
  }

  /** Pick the healthiest, most recently started bridge (fallback when no workspace context).
   * Tie-breaks on consecutiveFailures ascending to match pickForWorkspace() behavior. */
  pickBest(): ChildBridge | null {
    const healthy = [...this.bridges.values()].filter((b) => b.healthy);
    if (healthy.length === 0) return null;
    return (
      healthy.sort((a, b) => {
        if (a.consecutiveFailures !== b.consecutiveFailures) {
          return a.consecutiveFailures - b.consecutiveFailures;
        }
        return b.startedAt - a.startedAt;
      })[0] ?? null
    );
  }

  /** Edge case 2: return workspace paths shared by 2+ bridges. */
  getDuplicateWorkspaces(): Map<string, ChildBridge[]> {
    const byWorkspace = new Map<string, ChildBridge[]>();
    for (const b of this.bridges.values()) {
      if (!b.healthy) continue;
      const existing = byWorkspace.get(b.workspace) ?? [];
      existing.push(b);
      byWorkspace.set(b.workspace, existing);
    }
    const dupes = new Map<string, ChildBridge[]>();
    for (const [ws, bridges] of byWorkspace) {
      if (bridges.length > 1) dupes.set(ws, bridges);
    }
    return dupes;
  }

  /** Edge case 3: rejected lock file ports with their rejection reasons. */
  getRejected(): Array<{ port: number; reason: string }> {
    return Array.from(this.rejectedPorts.entries()).map(([port, reason]) => ({
      port,
      reason,
    }));
  }

  get(port: number): ChildBridge | undefined {
    return this.bridges.get(port);
  }
}
