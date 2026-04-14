/**
 * Headless LSP client: JSON-RPC 2.0 over stdio to typescript-language-server.
 *
 * Content-Length framing (LSP wire format):
 *   "Content-Length: N\r\n\r\n<N bytes of JSON>"
 *
 * Lifecycle:
 *   1. spawn typescript-language-server --stdio
 *   2. send initialize request, wait for response
 *   3. send initialized notification
 *   4. openFile (textDocument/didOpen) before any hover/definition/references
 *   5. call request() for individual LSP requests
 *   6. dispose() kills the process and clears pending map
 */
import { type ChildProcess, spawn } from "node:child_process";

interface LspRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

interface LspResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

interface LspNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export class HeadlessLspClient {
  private proc: ChildProcess | null = null;
  private pending = new Map<
    number,
    { resolve: (r: LspResponse) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private buffer = "";
  private openedFiles = new Set<string>();

  /** True when the client has a live process and completed initialization. */
  get isReady(): boolean {
    return this.initialized && this.proc !== null;
  }

  /** Initialize: spawn process, send initialize + initialized. Idempotent. */
  async initialize(workspaceRoot: string): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInit(workspaceRoot);
    return this.initPromise;
  }

  private async _doInit(workspaceRoot: string): Promise<void> {
    let proc: ChildProcess;
    try {
      proc = spawn("typescript-language-server", ["--stdio"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      this.initPromise = null;
      throw new Error(
        `typescript-language-server not available: install with npm install -g typescript-language-server typescript. Original: ${String(err)}`,
      );
    }

    this.proc = proc;

    // Accumulate stdout into buffer and dispatch complete messages
    proc.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf-8");
      this._drain();
    });

    proc.on("exit", () => {
      this.proc = null;
      this.initialized = false;
      this.initPromise = null;
      // Reject all pending requests
      for (const [, { reject }] of this.pending) {
        reject(new Error("LSP process exited"));
      }
      this.pending.clear();
    });

    proc.on("error", (err) => {
      this.proc = null;
      this.initialized = false;
      this.initPromise = null;
      for (const [, { reject }] of this.pending) {
        reject(err);
      }
      this.pending.clear();
    });

    // Send initialize request
    const rootUri = `file://${workspaceRoot}`;
    await this.request(
      "initialize",
      {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            hover: { contentFormat: ["markdown", "plaintext"] },
            definition: { linkSupport: false },
            references: {},
          },
        },
        initializationOptions: {},
      },
      15_000,
    );

    // Send initialized notification (no response expected)
    this._sendNotification("initialized", {});
    this.initialized = true;
  }

  /** Parse and dispatch complete LSP messages from the buffer. */
  private _drain(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Skip malformed header
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = Number.parseInt(match[1]!, 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      if (this.buffer.length < bodyEnd) break; // incomplete body — wait for more data

      const body = this.buffer.slice(bodyStart, bodyEnd);
      this.buffer = this.buffer.slice(bodyEnd);

      let msg: LspResponse;
      try {
        msg = JSON.parse(body) as LspResponse;
      } catch {
        continue; // skip unparseable message
      }

      if (typeof msg.id === "number") {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          pending.resolve(msg);
        }
      }
    }
  }

  /** Send a JSON-RPC request and wait for the response. */
  async request(
    method: string,
    params: unknown,
    timeoutMs = 10_000,
  ): Promise<unknown> {
    if (!this.proc?.stdin) {
      throw new Error("LSP process not running");
    }

    const id = this.nextId++;
    const msg: LspRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`LSP request ${method} timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (res) => {
          clearTimeout(timer);
          if (res.error) {
            reject(
              new Error(`LSP error ${res.error.code}: ${res.error.message}`),
            );
          } else {
            resolve(res.result);
          }
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      const body = JSON.stringify(msg);
      const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
      try {
        this.proc?.stdin?.write(header + body);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  private _sendNotification(method: string, params: unknown): void {
    if (!this.proc?.stdin) return;
    const msg: LspNotification = { jsonrpc: "2.0", method, params };
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    try {
      this.proc.stdin.write(header + body);
    } catch {
      // best-effort
    }
  }

  /** Open a file in the LSP server (required before hover/definition/references). */
  async openFile(uri: string, languageId: string, text: string): Promise<void> {
    if (this.openedFiles.has(uri)) return; // already open
    this.openedFiles.add(uri);
    this._sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
    // Small delay to let the server index the file
    await new Promise<void>((r) => setTimeout(r, 200));
  }

  /** Kill the process and clear all pending requests. */
  dispose(): void {
    for (const [, { reject }] of this.pending) {
      reject(new Error("LSP client disposed"));
    }
    this.pending.clear();
    this.openedFiles.clear();
    this.initialized = false;
    this.initPromise = null;
    try {
      this.proc?.kill();
    } catch {
      // ignore
    }
    this.proc = null;
  }
}

// ---- Singleton management ----

let _client: HeadlessLspClient | null = null;

export function getHeadlessLspClient(): HeadlessLspClient {
  if (!_client) {
    _client = new HeadlessLspClient();
  }
  return _client;
}

export function disposeHeadlessLspClient(): void {
  if (_client) {
    _client.dispose();
    _client = null;
  }
}
