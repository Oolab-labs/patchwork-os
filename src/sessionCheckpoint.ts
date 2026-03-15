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
}

export class SessionCheckpoint {
  private checkpointPath: string;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(port: number) {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    this.checkpointPath = path.join(
      configDir,
      "ide",
      `checkpoint-${port}.json`,
    );
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
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
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

  /** Load the most recent checkpoint for any port (finds newest file). */
  static loadLatest(maxAgeMs = 5 * 60 * 1000): CheckpointData | null {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const ideDir = path.join(configDir, "ide");
    try {
      const files = fs
        .readdirSync(ideDir)
        .filter((f) => f.startsWith("checkpoint-") && f.endsWith(".json"))
        .map((f) => path.join(ideDir, f));

      if (files.length === 0) return null;

      // Find the most recently modified checkpoint
      let newest: { file: string; mtime: number } | null = null;
      for (const file of files) {
        try {
          const stat = fs.statSync(file);
          if (!newest || stat.mtimeMs > newest.mtime) {
            newest = { file, mtime: stat.mtimeMs };
          }
        } catch {
          // skip unreadable files
        }
      }
      if (!newest) return null;

      const raw = fs.readFileSync(newest.file, "utf8");
      const checkpoint = JSON.parse(raw) as CheckpointData;

      // Use savedAt from the checkpoint JSON for staleness — filesystem mtime is
      // unreliable when a file is copied or restored from backup.
      if (Date.now() - checkpoint.savedAt > maxAgeMs) return null;

      return checkpoint;
    } catch {
      return null;
    }
  }
}
