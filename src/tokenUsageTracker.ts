import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TokenTotals {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  total: number;
  messages: number;
}

export interface TokenUsageTrackerOptions {
  workspace: string;
  projectsDir?: string;
  pollIntervalMs?: number;
  logger?: { warn: (msg: string) => void };
}

interface FileState {
  offset: number;
  partial: string;
}

export function workspaceToProjectSlug(workspace: string): string {
  return workspace.replace(/[^a-zA-Z0-9]+/g, "-");
}

export class TokenUsageTracker {
  private readonly projectsDir: string;
  private readonly pollIntervalMs: number;
  private readonly logger?: { warn: (msg: string) => void };
  private readonly files = new Map<string, FileState>();
  private readonly seenMessageIds = new Set<string>();
  private totals: TokenTotals = {
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    total: 0,
    messages: 0,
  };
  private timer: NodeJS.Timeout | null = null;
  private _scanning = false;

  constructor(opts: TokenUsageTrackerOptions) {
    const slug = workspaceToProjectSlug(opts.workspace);
    this.projectsDir =
      opts.projectsDir ?? path.join(os.homedir(), ".claude", "projects", slug);
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.logger = opts.logger;
  }

  start(): void {
    if (this.timer) return;
    void this.scan();
    this.timer = setInterval(() => {
      void this.scan();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getTotals(): TokenTotals {
    return { ...this.totals };
  }

  async scan(): Promise<void> {
    if (this._scanning) return;
    this._scanning = true;
    try {
      let entries: string[];
      try {
        entries = await fs.promises.readdir(this.projectsDir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (!name.endsWith(".jsonl")) continue;
        const full = path.join(this.projectsDir, name);
        await this.readDelta(full);
      }
    } finally {
      this._scanning = false;
    }
  }

  private async readDelta(filePath: string): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      return;
    }
    const state = this.files.get(filePath) ?? { offset: 0, partial: "" };
    if (stat.size < state.offset) {
      // truncated/rotated — restart from beginning
      state.offset = 0;
      state.partial = "";
    }
    if (stat.size === state.offset) {
      this.files.set(filePath, state);
      return;
    }
    let chunk: Buffer;
    try {
      const len = stat.size - state.offset;
      chunk = Buffer.alloc(len);
      const fh = await fs.promises.open(filePath, "r");
      try {
        await fh.read(chunk, 0, len, state.offset);
      } finally {
        await fh.close();
      }
    } catch (err) {
      this.logger?.warn(
        `[tokens] read failed ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const text = state.partial + chunk.toString("utf8");
    const lines = text.split("\n");
    state.partial = lines.pop() ?? "";
    state.offset = stat.size;
    for (const line of lines) {
      if (!line.trim()) continue;
      this.ingestLine(line);
    }
    this.files.set(filePath, state);
  }

  private ingestLine(line: string): void {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (!obj || typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;
    if (o.type !== "assistant") return;
    const message = o.message as Record<string, unknown> | undefined;
    if (!message) return;
    const id = typeof message.id === "string" ? message.id : null;
    if (!id || this.seenMessageIds.has(id)) return;
    // L9: prevent unbounded growth on long-lived bridges — evict oldest IDs
    // when the set exceeds 50 000 entries (~4 MB for typical 80-char IDs).
    if (this.seenMessageIds.size >= 50_000) {
      const first = this.seenMessageIds.values().next().value;
      if (first !== undefined) this.seenMessageIds.delete(first);
    }
    const usage = message.usage as Record<string, unknown> | undefined;
    if (!usage) return;
    const input = numField(usage, "input_tokens");
    const output = numField(usage, "output_tokens");
    const cacheCreate = numField(usage, "cache_creation_input_tokens");
    const cacheRead = numField(usage, "cache_read_input_tokens");
    if (input + output + cacheCreate + cacheRead === 0) return;
    this.seenMessageIds.add(id);
    this.totals.input += input;
    this.totals.output += output;
    this.totals.cacheCreate += cacheCreate;
    this.totals.cacheRead += cacheRead;
    this.totals.total = this.totals.input + this.totals.output;
    this.totals.messages += 1;
  }
}

function numField(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
