import * as http from "node:http";
import type * as vscode from "vscode";
import type { LockFileData } from "./types";

export interface AnalyticsReport {
  generatedAt: string;
  windowHours: number;
  topTools: Array<{
    tool: string;
    calls: number;
    errors: number;
    avgMs: number;
  }>;
  hooksLast24h: number;
  recentAutomationTasks: Array<{
    id: string;
    status: string;
    triggerSource?: string;
    durationMs?: number;
    createdAt: string;
  }>;
  hint?: string;
}

export class AnalyticsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "claudeIdeBridge.analyticsView";

  private _view?: vscode.WebviewView;
  private _refreshTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getReport: () => Promise<AnalyticsReport | null>,
    private readonly getLockFile: () => Promise<LockFileData | null>,
    private readonly vscodeApi: typeof import("vscode"),
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    const refresh = async () => {
      try {
        const report = await this.getReport();
        webviewView.webview.html = this._buildHtml(report);
      } catch {
        webviewView.webview.html = this._buildHtml(null);
      }
    };

    void refresh();
    this._refreshTimer = setInterval(() => void refresh(), 30_000);

    webviewView.onDidDispose(() => {
      if (this._refreshTimer) clearInterval(this._refreshTimer);
    });

    webviewView.webview.onDidReceiveMessage((msg: { command: string }) => {
      if (msg.command === "refresh") void refresh();
      if (msg.command === "startTask") void this._handleStartTask(webviewView);
    });
  }

  /** Call a bridge MCP tool via Streamable HTTP transport. */
  private async _callBridgeTool(
    lock: LockFileData,
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<unknown> {
    // Step 1: initialize session
    const sessionId = await new Promise<string>((resolve, reject) => {
      const initBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "analyticsPanel", version: "1.0" },
        },
      });
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: lock.port,
          path: "/mcp",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${lock.authToken}`,
            "Content-Length": Buffer.byteLength(initBody),
          },
        },
        (res) => {
          const sid = res.headers["mcp-session-id"];
          if (!sid || typeof sid !== "string") {
            reject(new Error("No MCP session ID in initialize response"));
            res.resume();
            return;
          }
          res.resume();
          resolve(sid);
        },
      );
      req.on("error", reject);
      req.write(initBody);
      req.end();
    });

    // Step 2: send initialized notification
    await new Promise<void>((resolve, reject) => {
      const notifBody = JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: lock.port,
          path: "/mcp",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${lock.authToken}`,
            "mcp-session-id": sessionId,
            "Content-Length": Buffer.byteLength(notifBody),
          },
        },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.on("error", reject);
      req.write(notifBody);
      req.end();
    });

    // Step 3: call the tool
    return new Promise<unknown>((resolve, reject) => {
      const callBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: toolName, arguments: toolArgs },
      });
      let raw = "";
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port: lock.port,
          path: "/mcp",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${lock.authToken}`,
            "mcp-session-id": sessionId,
            "Content-Length": Buffer.byteLength(callBody),
          },
        },
        (res) => {
          res.on("data", (chunk: Buffer) => {
            raw += chunk.toString();
          });
          res.on("end", () => {
            try {
              // Response may be SSE or plain JSON
              const jsonLine = raw
                .split("\n")
                .find((l) => l.startsWith("data:") || l.startsWith("{"));
              const jsonStr = jsonLine?.startsWith("data:")
                ? jsonLine.slice(5).trim()
                : raw.trim();
              const parsed = JSON.parse(jsonStr) as {
                result?: { content?: unknown[] };
              };
              resolve(parsed.result);
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on("error", reject);
      req.write(callBody);
      req.end();
    });
  }

  private _buildTaskPrompt(
    description: string,
    brief: Record<string, unknown> | null,
    handoffNote: string | null,
  ): string {
    const lines: string[] = [];
    if (brief?.activeFile)
      lines.push(`Active file: ${brief.activeFile as string}`);
    const errors = brief?.recentErrors as
      | Array<{ message: string }>
      | undefined;
    if (errors?.length) {
      lines.push(
        `Errors: ${errors
          .map((e) => e.message)
          .slice(0, 3)
          .join("; ")}`,
      );
    }
    const commits = brief?.recentCommits as
      | Array<{ message: string }>
      | undefined;
    if (commits?.[0]) lines.push(`Last commit: ${commits[0].message}`);
    if (handoffNote)
      lines.push(`Prior context: ${String(handoffNote).slice(0, 400)}`);
    return lines.length
      ? `Context:\n${lines.join("\n")}\n\nTask: ${description}`
      : description;
  }

  private async _handleStartTask(
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    const vscode = this.vscodeApi;

    const description = await vscode.window.showInputBox({
      prompt: "What should Claude do?",
      placeHolder: "Describe the task…",
      ignoreFocusOut: true,
    });

    if (!description) return;

    webviewView.webview.postMessage({ command: "taskStarting" });

    const lock = await this.getLockFile();
    if (!lock) {
      webviewView.webview.postMessage({
        command: "taskError",
        message: "Bridge not connected — start the bridge first.",
      });
      return;
    }

    let brief: Record<string, unknown> | null = null;
    let handoffNote: string | null = null;

    try {
      const ctxResult = (await this._callBridgeTool(
        lock,
        "getProjectContext",
        {},
      )) as {
        content?: Array<{ text?: string }>;
      } | null;
      if (ctxResult?.content?.[0]?.text) {
        try {
          const parsed = JSON.parse(ctxResult.content[0].text) as {
            brief?: Record<string, unknown>;
          };
          brief = parsed.brief ?? null;
        } catch {
          // ignore parse errors
        }
      }
    } catch {
      // non-fatal — continue without context
    }

    try {
      const noteResult = (await this._callBridgeTool(
        lock,
        "getHandoffNote",
        {},
      )) as {
        content?: Array<{ text?: string }>;
      } | null;
      if (noteResult?.content?.[0]?.text) {
        try {
          const parsed = JSON.parse(noteResult.content[0].text) as {
            note?: string;
          };
          handoffNote = parsed.note ?? null;
        } catch {
          handoffNote = noteResult.content[0].text ?? null;
        }
      }
    } catch {
      // non-fatal
    }

    const prompt = this._buildTaskPrompt(description, brief, handoffNote);

    try {
      const taskResult = (await this._callBridgeTool(lock, "runClaudeTask", {
        prompt,
      })) as {
        content?: Array<{ text?: string }>;
      } | null;

      let taskId = "unknown";
      if (taskResult?.content?.[0]?.text) {
        try {
          const parsed = JSON.parse(taskResult.content[0].text) as {
            taskId?: string;
          };
          taskId = parsed.taskId ?? taskId;
        } catch {
          // ignore
        }
      }

      webviewView.webview.postMessage({ command: "taskStarted", taskId });
    } catch (err: unknown) {
      webviewView.webview.postMessage({
        command: "taskError",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private _buildHtml(report: AnalyticsReport | null): string {
    if (!report) {
      return `<html><body style="font-family:var(--vscode-font-family);padding:8px;color:var(--vscode-foreground)"><p>Bridge not connected.</p></body></html>`;
    }

    const toolRows = report.topTools
      .slice(0, 8)
      .map(
        (t) =>
          `<tr><td>${_escHtml(t.tool)}</td><td>${t.calls}</td><td>${t.errors}</td><td>${t.avgMs}ms</td></tr>`,
      )
      .join("");

    const taskRows = report.recentAutomationTasks
      .slice(0, 5)
      .map(
        (t) =>
          `<tr><td>${_escHtml(t.triggerSource ?? "manual")}</td><td>${_escHtml(t.status)}</td><td>${t.durationMs != null ? `${t.durationMs}ms` : "—"}</td></tr>`,
      )
      .join("");

    return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; margin: 12px 0 4px; color: var(--vscode-descriptionForeground); }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  td, th { padding: 2px 4px; border-bottom: 1px solid var(--vscode-widget-border, #333); text-align: left; }
  .stat { font-size: 22px; font-weight: 600; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 8px; cursor: pointer; font-size: 11px; margin-top: 8px; margin-right: 4px; }
  #taskStatus { font-size: 11px; margin-top: 6px; color: var(--vscode-descriptionForeground); min-height: 16px; }
</style>
</head>
<body>
<h3>Hooks fired (${report.windowHours}h)</h3>
<div class="stat">${report.hooksLast24h}</div>
<h3>Top tools</h3>
<table><tr><th>Tool</th><th>Calls</th><th>Err</th><th>Avg</th></tr>${toolRows || "<tr><td colspan=4>No data</td></tr>"}</table>
<h3>Recent automation tasks</h3>
<table><tr><th>Hook</th><th>Status</th><th>Duration</th></tr>${taskRows || "<tr><td colspan=3>No tasks</td></tr>"}</table>
<button onclick="vscodeApi.postMessage({command:'refresh'})">&#8635; Refresh</button>
<button onclick="vscodeApi.postMessage({command:'startTask'})">&#9654; Start Task</button>
<div id="taskStatus"></div>
<script>
const vscodeApi = acquireVsCodeApi();
window.addEventListener('message', function(event) {
  var msg = event.data;
  var el = document.getElementById('taskStatus');
  if (!el) return;
  if (msg.command === 'taskStarting') {
    el.textContent = 'Starting task\u2026';
  } else if (msg.command === 'taskStarted') {
    el.textContent = 'Task started: ' + msg.taskId;
    setTimeout(function() { if (el.textContent && el.textContent.startsWith('Task started')) el.textContent = ''; }, 5000);
  } else if (msg.command === 'taskError') {
    el.textContent = 'Error: ' + msg.message;
    setTimeout(function() { if (el.textContent && el.textContent.startsWith('Error')) el.textContent = ''; }, 5000);
  }
});
</script>
</body>
</html>`;
  }
}

function _escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
