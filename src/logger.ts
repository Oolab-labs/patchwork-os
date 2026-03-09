export class Logger {
  constructor(
    private verbose = false,
    private jsonl = false,
  ) {}

  private ts(): string {
    return new Date().toISOString();
  }

  info(msg: string, ...args: unknown[]): void {
    if (this.jsonl) {
      this.emitJsonl("info", msg);
    } else {
      console.error(`[bridge ${this.ts()}] ${msg}`, ...args);
    }
  }

  warn(msg: string, ...args: unknown[]): void {
    if (this.jsonl) {
      this.emitJsonl("warn", msg);
    } else {
      console.error(`[bridge ${this.ts()}] WARN ${msg}`, ...args);
    }
  }

  error(msg: string, ...args: unknown[]): void {
    if (this.jsonl) {
      this.emitJsonl("error", msg);
    } else {
      console.error(`[bridge ${this.ts()}] ERROR ${msg}`, ...args);
    }
  }

  debug(msg: string, ...args: unknown[]): void {
    if (this.verbose) {
      if (this.jsonl) {
        this.emitJsonl("debug", msg);
      } else {
        console.error(`[bridge ${this.ts()}] DEBUG ${msg}`, ...args);
      }
    }
  }

  /** Emit a structured event (always emitted in jsonl mode, regardless of verbose) */
  event(type: string, data?: Record<string, unknown>): void {
    if (this.jsonl) {
      const entry: Record<string, unknown> = {
        ts: this.ts(),
        event: type,
      };
      if (data) Object.assign(entry, data);
      console.error(JSON.stringify(entry));
    }
  }

  private emitJsonl(level: string, msg: string): void {
    console.error(JSON.stringify({ ts: this.ts(), level, msg }));
  }
}
