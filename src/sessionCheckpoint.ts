import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface SessionSnapshot {
  id: string;
  connectedAt: number;
  openedFiles: string[];
  terminalPrefix: string;
  inGrace: boolean;
}

export interface CheckpointData {
  port: number;
  savedAt: number;
  sessions: SessionSnapshot[];
  extensionConnected: boolean;
  gracePeriodMs: number;
  /** Absolute path of the workspace this checkpoint belongs to. Used to prevent
   *  cross-contamination when multiple bridge instances run on different workspaces. */
  workspace?: string;
}

export class SessionCheckpoint {
  private checkpointPath: string;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private readonly workspace: string | undefined;

  constructor(port: number, workspace?: string) {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    this.checkpointPath = path.join(
      configDir,
      "ide",
      `checkpoint-${port}.json`,
    );
    this.workspace = workspace;
  }

  /** Start writing checkpoints every `intervalMs` ms (default: 30s). */
  start(getSnapshot: () => CheckpointData, intervalMs = 30_000): void {
    // Write immediately on start
    this.write(getSnapshot());
    this.intervalHandle = setInterval(() => {
      this.write(getSnapshot());
    }, intervalMs);
    this.intervalHandle.unref(); // Don't prevent process exit
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.delete();
  }

  write(data: CheckpointData): void {
    try {
      const dir = path.dirname(this.checkpointPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Write atomically: write to a temp file then rename so a crash mid-write
      // never leaves a truncated or partially-written checkpoint file.
      const tmpPath = `${this.checkpointPath}.tmp`;
      // Include workspace so loadLatest can filter by workspace and prevent
      // cross-contamination between bridge instances on different workspaces.
      const dataWithWorkspace: CheckpointData =
        this.workspace !== undefined
          ? { ...data, workspace: this.workspace }
          : data;
      fs.writeFileSync(tmpPath, JSON.stringify(dataWithWorkspace, null, 2), {
        mode: 0o600,
      });
      fs.renameSync(tmpPath, this.checkpointPath);
      // Ensure restrictive permissions even if the file pre-existed with a wider mode.
      fs.chmodSync(this.checkpointPath, 0o600);
    } catch {
      // Best-effort — never block bridge operation
    }
  }

  delete(): void {
    try {
      fs.unlinkSync(this.checkpointPath);
    } catch {
      // ignore if already gone
    }
  }

  /** Load the most recent checkpoint for any port (finds newest file).
   *
   * @param maxAgeMs  Reject checkpoints older than this (default: 5 minutes).
   * @param workspace If provided, only return checkpoints whose `workspace`
   *                  field matches. Checkpoints written without a workspace
   *                  field (pre-v2.1.32 format) are always accepted so that
   *                  upgrading users don't lose their checkpoint on first boot.
   */
  static loadLatest(
    maxAgeMs = 5 * 60 * 1000,
    workspace?: string,
  ): CheckpointData | null {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const ideDir = path.join(configDir, "ide");
    try {
      const files = fs
        .readdirSync(ideDir)
        .filter((f) => f.startsWith("checkpoint-") && f.endsWith(".json"))
        .map((f) => path.join(ideDir, f));

      if (files.length === 0) return null;

      // Parse all candidate files and sort by savedAt (from JSON) descending.
      // This is more reliable than mtime, which can be wrong after a file copy or backup restore.
      const parsed: { file: string; checkpoint: CheckpointData }[] = [];
      for (const file of files) {
        try {
          const raw = fs.readFileSync(file, "utf8");
          const checkpoint = JSON.parse(raw) as CheckpointData;
          if (!Array.isArray(checkpoint.sessions)) continue; // skip malformed
          // Filter by workspace when both the caller and the checkpoint specify one.
          // Checkpoints without a workspace field are accepted unconditionally (upgrade compat).
          if (
            workspace !== undefined &&
            checkpoint.workspace !== undefined &&
            checkpoint.workspace !== workspace
          ) {
            continue;
          }
          parsed.push({ file, checkpoint });
        } catch {
          // skip unreadable or unparseable files
        }
      }
      if (parsed.length === 0) return null;

      // Sort by savedAt descending — highest savedAt is most recent
      parsed.sort((a, b) => b.checkpoint.savedAt - a.checkpoint.savedAt);

      // biome-ignore lint/style/noNonNullAssertion: sorted array is non-empty (checked above)
      const { checkpoint } = parsed[0]!;

      // Reject checkpoints with a future savedAt (clock skew tolerance: 5s)
      if (checkpoint.savedAt > Date.now() + 5_000) return null;

      // Use savedAt from the checkpoint JSON for staleness — filesystem mtime is
      // unreliable when a file is copied or restored from backup.
      if (Date.now() - checkpoint.savedAt > maxAgeMs) {
        console.warn(
          `[sessionCheckpoint] Ignoring stale checkpoint (savedAt=${new Date(checkpoint.savedAt).toISOString()}, age=${Math.round((Date.now() - checkpoint.savedAt) / 1000)}s > maxAge=${Math.round(maxAgeMs / 1000)}s)`,
        );
        return null;
      }

      return checkpoint;
    } catch {
      return null;
    }
  }
}
