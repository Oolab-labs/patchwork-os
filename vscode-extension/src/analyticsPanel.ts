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
    prompt?: string;
    durationMs?: number;
    createdAt: string;
  }>;
  hint?: string;
}

const PRESETS: Record<string, string> = {
  fixErrors:
    "Fix all errors and warnings shown in the diagnostics panel. Run tests after to confirm.",
  refactorFile:
    "Refactor the active file for clarity and maintainability. Keep behaviour identical.",
  addTests:
    "Add comprehensive unit tests for the active file. Follow existing test patterns in the project.",
};

export class AnalyticsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "claudeIdeBridge.analyticsView";

  private _view?: vscode.WebviewView;
  private _refreshTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getReport: () => Promise<AnalyticsReport | null>,
    private readonly _getLockFile: () => Promise<LockFileData | null>,
    private readonly vscodeApi: typeof import("vscode"),
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    const refresh = async () => {
      try {
        const report = await this.getReport();
        let handoffPreview: string | null = null;
        try {
          const lock = await this._getLockFile();
          if (lock) {
            const noteResult = (await this._callBridgeTool(
              lock,
              "getHandoffNote",
              {},
            )) as { content?: Array<{ text?: string }> } | null;
            if (noteResult?.content?.[0]?.text) {
              try {
                const parsed = JSON.parse(noteResult.content[0].text) as {
                  note?: string;
                };
                handoffPreview = parsed.note ?? null;
              } catch {
                handoffPreview = noteResult.content[0].text ?? null;
              }
            }
          }
        } catch {
          // non-fatal
        }
        webviewView.webview.html = this._buildHtml(report, handoffPreview);
      } catch {
        webviewView.webview.html = this._buildHtml(null, null);
      }
    };

    void refresh();
    this._refreshTimer = setInterval(() => void refresh(), 30_000);

    webviewView.onDidDispose(() => {
      if (this._refreshTimer) clearInterval(this._refreshTimer);
    });

    webviewView.webview.onDidReceiveMessage(
      (msg: { command: string; taskId?: string; key?: string }) => {
        if (msg.command === "refresh") void refresh();
        if (msg.command === "startTask")
          void this._handleStartTask(webviewView);
        if (msg.command === "resumeTask" && msg.taskId)
          void this._handleResumeTask(webviewView, msg.taskId);
        if (msg.command === "preset" && msg.key)
          void this._handlePreset(webviewView, msg.key);
        if (msg.command === "continueHandoff")
          void this._handleContinueHandoff(webviewView);
      },
    );
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

  /** Shared logic: gather context + run a task with a pre-known description. */
  private async _launchWithDescription(
    description: string,
    view: vscode.WebviewView,
  ): Promise<void> {
    view.webview.postMessage({ command: "taskStarting" });

    const lock = await this._getLockFile();
    if (!lock) {
      view.webview.postMessage({
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

      view.webview.postMessage({ command: "taskStarted", taskId });
    } catch (err: unknown) {
      view.webview.postMessage({
        command: "taskError",
        message: err instanceof Error ? err.message : String(err),
      });
    }
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

    await this._launchWithDescription(description, webviewView);
  }

  private async _handlePreset(
    view: vscode.WebviewView,
    key: string,
  ): Promise<void> {
    const description = PRESETS[key];
    if (!description) return;
    await this._launchWithDescription(description, view);
  }

  private async _handleResumeTask(
    view: vscode.WebviewView,
    taskId: string,
  ): Promise<void> {
    view.webview.postMessage({
      command: "taskStarting",
      message: `Resuming ${taskId.slice(0, 8)}…`,
    });
    try {
      const lock = await this._getLockFile();
      if (!lock) throw new Error("Bridge not running");
      const result = (await this._callBridgeTool(lock, "resumeClaudeTask", {
        taskId,
      })) as { content?: Array<{ text?: string }> } | null;
      let newTaskId = "unknown";
      if (result?.content?.[0]?.text) {
        try {
          const parsed = JSON.parse(result.content[0].text) as {
            newTaskId?: string;
          };
          newTaskId = parsed.newTaskId ?? newTaskId;
        } catch {
          // ignore
        }
      }
      view.webview.postMessage({ command: "taskStarted", taskId: newTaskId });
    } catch (err) {
      view.webview.postMessage({
        command: "taskError",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async _handleContinueHandoff(
    view: vscode.WebviewView,
  ): Promise<void> {
    view.webview.postMessage({ command: "taskStarting" });
    try {
      const lock = await this._getLockFile();
      if (!lock) throw new Error("Bridge not running");
      const noteResult = (await this._callBridgeTool(
        lock,
        "getHandoffNote",
        {},
      )) as { content?: Array<{ text?: string }> } | null;
      let note: string | null = null;
      if (noteResult?.content?.[0]?.text) {
        try {
          const parsed = JSON.parse(noteResult.content[0].text) as {
            note?: string;
          };
          note = parsed.note ?? null;
        } catch {
          note = noteResult.content[0].text ?? null;
        }
      }
      if (!note?.trim()) throw new Error("No handoff note found");
      const prompt = `Continue from where we left off.\n\nHandoff note:\n${note}\n\nPick up the next action and proceed.`;
      const taskResult = (await this._callBridgeTool(lock, "runClaudeTask", {
        prompt,
        runInBackground: true,
      })) as { content?: Array<{ text?: string }> } | null;
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
      view.webview.postMessage({ command: "taskStarted", taskId });
    } catch (err) {
      view.webview.postMessage({
        command: "taskError",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private _buildHtml(
    report: AnalyticsReport | null,
    handoffPreview: string | null,
  ): string {
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

    const taskItems = report.recentAutomationTasks
      .slice(0, 5)
      .map((t) => {
        const statusClass = ["done", "error", "running", "pending"].includes(
          t.status,
        )
          ? t.status
          : "pending";
        const promptPreview = t.prompt
          ? _escHtml(t.prompt.slice(0, 60)) + (t.prompt.length > 60 ? "…" : "")
          : "(no prompt)";
        return `<div class="task-item">
  <div class="task-meta">
    <span class="task-source">${_escHtml(t.triggerSource ?? "manual")}</span>
    <span class="task-status ${statusClass}">${_escHtml(t.status)}</span>
  </div>
  <div class="task-prompt">${promptPreview}</div>
  <button onclick="vscodeApi.postMessage({command:'resumeTask',taskId:'${_escHtml(t.id)}'})">\u21a9 Resume</button>
</div>`;
      })
      .join("");

    const handoffBtnStyle = handoffPreview
      ? ""
      : ' style="opacity:0.5;cursor:not-allowed"';
    const handoffPreviewText = handoffPreview
      ? _escHtml(handoffPreview.slice(0, 80)) +
        (handoffPreview.length > 80 ? "…" : "")
      : "No handoff note available.";

    return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px; }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; margin: 12px 0 4px; color: var(--vscode-descriptionForeground); }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  td, th { padding: 2px 4px; border-bottom: 1px solid var(--vscode-widget-border, #333); text-align: left; }
  .stat { font-size: 22px; font-weight: 600; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 8px; cursor: pointer; font-size: 11px; margin-top: 4px; margin-right: 4px; }
  #taskStatus { font-size: 11px; margin-top: 6px; color: var(--vscode-descriptionForeground); min-height: 16px; }
  .task-item { border-bottom: 1px solid var(--vscode-widget-border, #333); padding: 4px 0; }
  .task-meta { display: flex; gap: 6px; align-items: center; margin-bottom: 2px; }
  .task-source { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .task-status { font-size: 10px; padding: 1px 4px; border-radius: 2px; }
  .task-status.done { background: var(--vscode-testing-iconPassed, #3fb950); color: #000; }
  .task-status.error { background: var(--vscode-testing-iconFailed, #f85149); color: #fff; }
  .task-status.running, .task-status.pending { background: var(--vscode-terminal-ansiYellow, #e3b341); color: #000; }
  .task-prompt { font-size: 10px; margin-bottom: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .presets { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
  .presets button { text-align: left; }
</style>
</head>
<body>
<h3>Session continuity</h3>
<button id="handoffBtn"${handoffBtnStyle} onclick="vscodeApi.postMessage({command:'continueHandoff'})">\u27f3 Continue from handoff note</button>
<div id="handoffPreview" style="font-size:10px;color:var(--vscode-descriptionForeground);margin:2px 0 8px;">${handoffPreviewText}</div>

<h3>Quick tasks</h3>
<div class="presets">
  <button onclick="vscodeApi.postMessage({command:'preset',key:'fixErrors'})">&#x1F527; Fix all errors</button>
  <button onclick="vscodeApi.postMessage({command:'preset',key:'refactorFile'})">&#x267B; Refactor this file</button>
  <button onclick="vscodeApi.postMessage({command:'preset',key:'addTests'})">&#x2713; Add tests</button>
</div>

<h3>Hooks fired (${report.windowHours}h)</h3>
<div class="stat">${report.hooksLast24h}</div>
<h3>Top tools</h3>
<table><tr><th>Tool</th><th>Calls</th><th>Err</th><th>Avg</th></tr>${toolRows || "<tr><td colspan=4>No data</td></tr>"}</table>
<h3>Recent automation tasks</h3>
${taskItems || "<p style='font-size:11px'>No tasks yet.</p>"}
<div style="margin-top:8px">
  <button onclick="vscodeApi.postMessage({command:'refresh'})">&#8635; Refresh</button>
  <button onclick="vscodeApi.postMessage({command:'startTask'})">&#9654; Start Task</button>
</div>
<div id="taskStatus"></div>
<script>
const vscodeApi = acquireVsCodeApi();
window.addEventListener('message', function(event) {
  var msg = event.data;
  var el = document.getElementById('taskStatus');
  if (!el) return;
  if (msg.command === 'taskStarting') {
    el.textContent = msg.message || 'Starting task\u2026';
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
