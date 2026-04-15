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
    output?: string;
    errorMessage?: string;
  }>;
  hint?: string;
}

export interface PerformanceReport {
  generatedAt: string;
  windowMinutes: number;
  latency: {
    perTool: Record<
      string,
      {
        p50: number;
        p95: number;
        p99: number;
        sampleCount: number;
        avgMs: number;
        calls: number;
        errorRate: number;
      }
    >;
    overallP95Ms: number;
  };
  throughput: {
    callsPerMinute: number;
    errorsPerMinute: number;
    errorRatePct: number;
    rateLimitRejectedTotal: number;
  };
  extension: {
    connected: boolean;
    rttMs: number | null;
    circuitBreakerSuspended: boolean;
    disconnectCount: number;
    connectionQuality: "healthy" | "degraded" | "poor" | "disconnected";
  };
  sessions: { active: number; inGrace: number };
  health: { score: number; signals: string[] };
}

const PRESETS: Record<string, { label: string; icon: string; prompt: string }> =
  {
    fixErrors: {
      label: "Fix all errors",
      icon: "⊘",
      prompt:
        "Call getDiagnostics to get all current errors and warnings. Fix every error precisely — do not break working code. Run tests after fixing to confirm nothing regressed.",
    },
    refactorFile: {
      label: "Refactor this file",
      icon: "↺",
      prompt:
        "Refactor the active file for clarity, readability, and maintainability. Keep all existing behaviour identical. Use getBufferContent to read the current file before making changes.",
    },
    addTests: {
      label: "Add tests",
      icon: "✓",
      prompt:
        "Write comprehensive unit tests for the functions in the active file. Use getBufferContent to read the file. Match the existing test style and patterns in the project. Cover edge cases.",
    },
    explainCode: {
      label: "Explain this file",
      icon: "◎",
      prompt:
        "Read the active file with getBufferContent and explain what it does: its purpose, key functions, data flow, and any non-obvious patterns. Keep it concise and technical.",
    },
    optimizePerf: {
      label: "Optimize performance",
      icon: "◆",
      prompt:
        "Analyse the active file for performance issues: unnecessary re-renders, expensive loops, blocking I/O, memory leaks. Use getBufferContent to read it, then propose and apply the most impactful fixes.",
    },
  };

export class AnalyticsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "claudeIdeBridge.analyticsView";
  private _refreshTimer?: ReturnType<typeof setInterval>;
  private _lastReport: AnalyticsReport | null = null;
  _view?: vscode.WebviewView;

  constructor(
    readonly _extensionUri: vscode.Uri,
    private readonly getReport: () => Promise<AnalyticsReport | null>,
    private readonly _getLockFile: () => Promise<LockFileData | null>,
    private readonly vscodeApi: typeof import("vscode"),
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    // Clear any stale timer from a previous resolveWebviewView call.
    // Windsurf and some VS Code forks call resolveWebviewView each time the
    // panel is shown without firing onDidDispose on the previous webview first.
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = undefined;
    }

    const refresh = async () => {
      try {
        const report = await this.getReport();
        if (report) this._lastReport = report;
        let handoffPreview: string | null = null;
        let perfReport: PerformanceReport | null = null;
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
            // Fetch performance report
            try {
              const perfResult = (await this._callBridgeTool(
                lock,
                "getPerformanceReport",
                {},
              )) as { content?: Array<{ text?: string }> } | null;
              if (perfResult?.content?.[0]?.text) {
                const parsed = JSON.parse(perfResult.content[0].text) as
                  | PerformanceReport
                  | { generatedAt?: string };
                if ("latency" in parsed && "health" in parsed) {
                  perfReport = parsed as PerformanceReport;
                }
              }
            } catch {
              // non-fatal
            }
          }
        } catch {
          // non-fatal
        }
        webviewView.webview.html = this._buildHtml(
          report,
          handoffPreview,
          perfReport,
        );
      } catch {
        webviewView.webview.html = this._buildHtml(null, null);
      }
    };

    void refresh();
    this._refreshTimer = setInterval(() => void refresh(), 15_000);

    // Refresh immediately when the panel regains visibility (e.g. switching
    // tabs in Windsurf or collapsing/expanding the sidebar panel).
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) void refresh();
    });

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
        if (msg.command === "viewOutput" && msg.taskId)
          this._handleViewOutput(webviewView, msg.taskId);
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

    // Step 3: call the tool, then DELETE the session to free the slot
    const result = await new Promise<unknown>((resolve, reject) => {
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
              // Response may be SSE (multiple data: lines) or plain JSON.
              // Use the LAST data: line to skip progress notifications and
              // get the final tools/call result.
              const lines = raw.split("\n");
              const dataLines = lines.filter((l) => l.startsWith("data:"));
              const jsonLine =
                dataLines.length > 0
                  ? dataLines[dataLines.length - 1]
                  : lines.find((l) => l.startsWith("{"));
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

    // Step 4: DELETE session to release the slot (fire-and-forget, non-fatal)
    try {
      await new Promise<void>((resolve) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: lock.port,
            path: "/mcp",
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${lock.authToken}`,
              "mcp-session-id": sessionId,
            },
          },
          (res) => {
            res.resume();
            resolve();
          },
        );
        req.on("error", () => resolve());
        req.end();
      });
    } catch {
      // non-fatal — session will expire via idle TTL
    }

    return result;
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
      title: "Start Claude Task",
      prompt: "Describe what you want Claude to work on",
      placeHolder:
        "e.g. Fix the auth flow bug, implement the payment feature, add tests for UserService…",
      ignoreFocusOut: true,
    });

    if (!description?.trim()) return;

    await this._launchWithDescription(description.trim(), webviewView);
  }

  private async _handlePreset(
    view: vscode.WebviewView,
    key: string,
  ): Promise<void> {
    const preset = PRESETS[key];
    if (!preset) return;
    await this._launchWithDescription(preset.prompt, view);
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

  private _handleViewOutput(view: vscode.WebviewView, taskId: string): void {
    // Task output comes from the analytics report (no session-scoping),
    // not getClaudeTaskStatus (which is scoped to the session that created
    // the task and would return task_not_found for automation tasks).
    const task = this._lastReport?.recentAutomationTasks.find(
      (t) => t.id === taskId,
    );
    if (!task) {
      view.webview.postMessage({
        command: "taskError",
        message: "Task not found — try refreshing.",
      });
      return;
    }
    const raw = task.output ?? task.errorMessage;
    // Check status FIRST, then output presence — avoids misclassifying
    // completed tasks with no output as "never started".
    const fallback =
      task.status === "running" || task.status === "pending"
        ? "(task is still running — output available when complete)"
        : task.status === "cancelled"
          ? "(task was cancelled before producing output)"
          : task.status === "done" || task.status === "error"
            ? "(task completed but produced no output)"
            : "(task was queued but never started)";
    const lines = (raw ?? "").split("\n").filter(Boolean);
    const tail = lines.length > 0 ? lines.slice(-20).join("\n") : fallback;
    view.webview.postMessage({
      command: "taskOutput",
      taskId,
      status: task.status,
      tail,
    });
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
    perfReport?: PerformanceReport | null,
  ): string {
    if (!report) {
      return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:8px;color:var(--vscode-foreground)">
<p style="color:var(--vscode-descriptionForeground);font-size:12px">Bridge not connected.</p>
<p style="font-size:11px">Start the bridge with:<br><code>claude-ide-bridge --watch --full</code></p>
</body></html>`;
    }

    // Active tasks (running or pending) shown prominently at top
    const activeTasks = report.recentAutomationTasks.filter((t) =>
      ["running", "pending"].includes(t.status),
    );
    const activeTasksHtml = activeTasks.length
      ? activeTasks
          .map(
            (t) => `<div class="active-task">
  <span class="spinner">⟳</span>
  <span class="active-task-label">${_escHtml(t.triggerSource ?? "manual")} — ${_escHtml(t.status)}</span>
  <div class="active-task-actions">
    <button class="view-output-btn" data-task-id="${_escHtml(t.id)}" title="Stream latest output">⊡ Output</button>
    <button class="resume-btn" data-task-id="${_escHtml(t.id)}">↩ Resume</button>
  </div>
</div>`,
          )
          .join("")
      : "";

    // Recent completed tasks (last 5)
    const recentTasks = report.recentAutomationTasks
      .filter((t) => !["running", "pending"].includes(t.status))
      .slice(0, 5)
      .map((t) => {
        const statusClass =
          t.status === "done"
            ? "done"
            : t.status === "cancelled" || t.status === "interrupted"
              ? "cancelled"
              : "error";
        const age = _relativeTime(t.createdAt);
        const dur =
          t.durationMs !== undefined
            ? ` · ${Math.round(t.durationMs / 1000)}s`
            : "";
        return `<div class="task-item">
  <div class="task-meta">
    <span class="task-source">${_escHtml(t.triggerSource ?? "manual")}</span>
    <span class="task-status ${statusClass}">${_escHtml(t.status)}</span>
    <span class="task-age">${age}${dur}</span>
  </div>
  <div style="display:flex;gap:4px">
    <button class="view-output-btn" data-task-id="${_escHtml(t.id)}" title="View task output">⊡ Output</button>
    <button class="resume-btn" data-task-id="${_escHtml(t.id)}">↩ Resume</button>
  </div>
</div>`;
      })
      .join("");

    // Handoff note — auto-snapshots are bridge metadata, not user context.
    // Detect by the [auto-snapshot ...] sentinel on the first non-empty line.
    const isAutoSnapshot =
      handoffPreview?.trimStart().startsWith("[auto-snapshot") ?? false;
    const handoffPreviewHtml = isAutoSnapshot
      ? `<div style="opacity:0.6">Auto-snapshot saved — no manual context yet.</div>`
      : handoffPreview != null
        ? handoffPreview
            .split(/\n+/)
            .slice(0, 2)
            .map((l) => `<div>${_escHtml(l.trim())}</div>`)
            .join("")
        : `<div style="opacity:0.6">No handoff note — start a session to create one.</div>`;
    // Auto-snapshots have no user context — treat like no handoff note.
    const hasManualNote = handoffPreview && !isAutoSnapshot;
    const handoffBtnLabel = hasManualNote
      ? "↺ Continue from handoff note"
      : "▶ Start fresh session";
    const handoffDataAttr = hasManualNote ? "" : ' data-fresh="1"';

    // Quick task preset buttons — use data-preset-key, not inline JS
    const presetButtons = Object.entries(PRESETS)
      .map(
        ([key, p]) =>
          `<button class="preset-btn" data-preset-key="${_escHtml(key)}"><span class="preset-icon">${p.icon}</span> ${_escHtml(p.label)}</button>`,
      )
      .join("");

    // Top tools table — guard NaN avgMs
    const toolRows = report.topTools
      .slice(0, 8)
      .map((t) => {
        const avg = Number.isFinite(t.avgMs) ? Math.round(t.avgMs) : 0;
        return `<tr><td>${_escHtml(t.tool)}</td><td>${t.calls}</td><td>${t.errors}</td><td>${avg}ms</td></tr>`;
      })
      .join("");

    // Health badge from performance report
    const healthScore = perfReport?.health?.score;
    const healthBadgeClass =
      healthScore === undefined
        ? ""
        : healthScore >= 80
          ? "health-green"
          : healthScore >= 50
            ? "health-yellow"
            : "health-red";
    const healthBadgeHtml =
      healthScore !== undefined
        ? `<span class="health-badge ${_escHtml(healthBadgeClass)}">${healthScore}</span>`
        : "";

    // Latency table from performance report
    const perfTools = perfReport?.latency?.perTool
      ? Object.entries(perfReport.latency.perTool)
          .filter(([, v]) => v.sampleCount >= 2)
          .sort(([, a], [, b]) => b.p95 - a.p95)
          .slice(0, 8)
      : [];
    const latencyRows = perfTools
      .map(
        ([tool, v]) =>
          `<tr><td>${_escHtml(tool)}</td><td>${v.calls}</td><td>${Number.isFinite(v.errorRate) ? v.errorRate.toFixed(1) : "0"}%</td><td>${v.p50}ms</td><td>${v.p95}ms</td></tr>`,
      )
      .join("");

    return `<!DOCTYPE html>
<html>
<head>
<style>
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px; margin: 0; }
  h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; margin: 14px 0 5px; color: var(--vscode-descriptionForeground); display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none; }
  h3 .toggle { font-size: 9px; opacity: 0.6; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  td, th { padding: 2px 4px; border-bottom: 1px solid var(--vscode-widget-border, #333); text-align: left; }
  th { font-size: 10px; color: var(--vscode-descriptionForeground); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 8px; cursor: pointer; font-size: 11px; border-radius: 2px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .handoff-box { border: 1px solid var(--vscode-widget-border, #444); border-radius: 3px; padding: 6px 8px; margin-bottom: 8px; }
  .handoff-preview { font-size: 10px; color: var(--vscode-descriptionForeground); margin: 4px 0 6px; line-height: 1.5; }
  .handoff-actions { display: flex; gap: 4px; }
  .active-task { display: flex; align-items: center; gap: 6px; background: var(--vscode-terminal-ansiBlue, #1f6feb22); border: 1px solid var(--vscode-focusBorder, #1f6feb55); border-radius: 3px; padding: 4px 6px; margin-bottom: 4px; font-size: 11px; }
  .active-task-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .spinner { animation: spin 1.2s linear infinite; display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .active-task-label { flex: 1; }
  .presets { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; margin-bottom: 6px; }
  .preset-btn { text-align: left; padding: 5px 6px; font-size: 11px; display: flex; align-items: center; gap: 4px; }
  .preset-icon { font-size: 13px; }
  .task-item { border-bottom: 1px solid var(--vscode-widget-border, #333); padding: 4px 0; font-size: 11px; }
  .task-meta { display: flex; gap: 5px; align-items: center; margin-bottom: 3px; flex-wrap: wrap; }
  .task-source { color: var(--vscode-descriptionForeground); font-size: 10px; }
  .task-age { color: var(--vscode-descriptionForeground); font-size: 10px; margin-left: auto; }
  .task-status { font-size: 10px; padding: 1px 5px; border-radius: 10px; font-weight: 600; }
  .task-status.done { background: var(--vscode-testing-iconPassed, #3fb950); color: #000; }
  .task-status.error { background: var(--vscode-testing-iconFailed, #f85149); color: #fff; }
  .task-status.cancelled { background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #ccc); }
  .bottom-bar { display: flex; gap: 4px; margin-top: 10px; align-items: center; }
  .bottom-bar .start-btn { flex: 1; padding: 6px; font-size: 12px; font-weight: 600; }
  .last-updated { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 5px; text-align: right; }
  #taskStatus { font-size: 11px; margin-top: 6px; color: var(--vscode-descriptionForeground); min-height: 16px; }
  .collapsible { overflow: hidden; transition: max-height 0.2s ease; }
  .collapsible.collapsed { max-height: 0 !important; }
  .health-badge { font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 10px; }
  .health-green { background: var(--vscode-testing-iconPassed, #3fb950); color: #000; }
  .health-yellow { background: var(--vscode-editorWarning-foreground, #cca700); color: #000; }
  .health-red { background: var(--vscode-testing-iconFailed, #f85149); color: #fff; }
</style>
</head>
<body>
${activeTasksHtml ? `<div style="margin-bottom:8px"><div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-descriptionForeground);margin-bottom:4px">▸ Active tasks</div>${activeTasksHtml}</div>` : ""}

<h3>Session continuity</h3>
<div class="handoff-box">
  <div class="handoff-preview">${handoffPreviewHtml}</div>
  <div class="handoff-actions">
    <button class="handoff-continue-btn"${handoffDataAttr}>${handoffBtnLabel}</button>
  </div>
</div>

<h3>Quick tasks</h3>
<div class="presets">${presetButtons}</div>

<h3 onclick="toggleSection('tasks')" title="Click to expand/collapse">Recent tasks <span class="toggle" id="tasks-toggle">▾</span></h3>
<div class="collapsible" id="tasks-body" style="max-height:500px">
  ${recentTasks || "<p style='font-size:11px;color:var(--vscode-descriptionForeground)'>No completed tasks yet.</p>"}
</div>

<h3 onclick="toggleSection('stats')" title="Click to expand/collapse">Stats ${healthBadgeHtml} <span class="toggle" id="stats-toggle">▸</span></h3>
<div class="collapsible collapsed" id="stats-body" style="max-height:500px">
  <div style="font-size:11px;margin-bottom:4px">Hooks fired (${report.windowHours}h): <strong>${report.hooksLast24h}</strong></div>
  <table><tr><th>Tool</th><th>Calls</th><th>Err</th><th>Avg</th></tr>${toolRows || "<tr><td colspan=4>No data yet</td></tr>"}</table>
</div>

${
  latencyRows
    ? `<h3 onclick="toggleSection('latency')" title="Click to expand/collapse">Latency <span class="toggle" id="latency-toggle">▸</span></h3>
<div class="collapsible collapsed" id="latency-body" style="max-height:500px">
  <table><tr><th>Tool</th><th>Calls</th><th>Err%</th><th>p50</th><th>p95</th></tr>${latencyRows}</table>
</div>`
    : ""
}

<div class="bottom-bar">
  <button id="refreshBtn">⟳</button>
  <button class="start-btn" id="startTaskBtn">▶ Start Task</button>
</div>
<div class="last-updated" id="lastUpdated"></div>
<div id="taskStatus"></div>

<script>
const vscodeApi = acquireVsCodeApi();
const generatedAt = new Date(${JSON.stringify(report.generatedAt)});

function updateAge() {
  var el = document.getElementById('lastUpdated');
  if (!el) return;
  var sec = Math.max(0, Math.round((Date.now() - generatedAt.getTime()) / 1000));
  el.textContent = 'Updated ' + (sec < 60 ? sec + 's' : Math.round(sec / 60) + 'm') + ' ago';
}
updateAge();
setInterval(updateAge, 5000);

function startTask() {
  var btn = document.getElementById('startTaskBtn');
  if (btn) { btn.textContent = '↺ Gathering context…'; btn.disabled = true; }
  vscodeApi.postMessage({ command: 'startTask' });
}

function toggleSection(id) {
  var body = document.getElementById(id + '-body');
  var tog = document.getElementById(id + '-toggle');
  if (!body || !tog) return;
  var collapsed = body.classList.toggle('collapsed');
  tog.textContent = collapsed ? '▸' : '▾';
}

// Delegated click handler — no inline JS, prevents XSS via task IDs or preset keys
document.addEventListener('click', function(e) {
  var target = e.target && e.target.closest ? e.target.closest('button') : null;
  if (!target) return;
  if (target.id === 'refreshBtn') {
    vscodeApi.postMessage({ command: 'refresh' });
  } else if (target.id === 'startTaskBtn') {
    startTask();
  } else if (target.classList.contains('view-output-btn')) {
    var taskId = target.getAttribute('data-task-id');
    if (taskId) vscodeApi.postMessage({ command: 'viewOutput', taskId: taskId });
  } else if (target.classList.contains('resume-btn')) {
    var taskId = target.getAttribute('data-task-id');
    if (taskId) vscodeApi.postMessage({ command: 'resumeTask', taskId: taskId });
  } else if (target.classList.contains('preset-btn')) {
    var key = target.getAttribute('data-preset-key');
    if (key) vscodeApi.postMessage({ command: 'preset', key: key });
  } else if (target.classList.contains('handoff-continue-btn')) {
    if (target.getAttribute('data-fresh')) {
      startTask();
    } else {
      vscodeApi.postMessage({ command: 'continueHandoff' });
    }
  }
});

window.addEventListener('message', function(event) {
  var msg = event.data;
  var el = document.getElementById('taskStatus');
  var btn = document.getElementById('startTaskBtn');
  if (msg.command === 'taskStarting') {
    if (el) el.textContent = msg.message || 'Starting task…';
  } else if (msg.command === 'taskStarted') {
    if (btn) { btn.textContent = '▶ Start Task'; btn.disabled = false; }
    if (el) {
      el.textContent = '✓ Task started (' + msg.taskId.slice(0, 8) + ')';
      setTimeout(function() { el.textContent = ''; }, 6000);
    }
  } else if (msg.command === 'taskError') {
    if (btn) { btn.textContent = '▶ Start Task'; btn.disabled = false; }
    if (el) {
      el.textContent = '✗ ' + msg.message;
      setTimeout(function() { el.textContent = ''; }, 8000);
    }
  } else if (msg.command === 'taskOutput') {
    var overlay = document.getElementById('outputOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'outputOverlay';
      overlay.style.cssText = 'position:fixed;inset:0;background:var(--vscode-editor-background);z-index:100;display:flex;flex-direction:column;padding:8px;overflow:hidden;';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"><span style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground)">Task output — ' + msg.status + '</span><button id="closeOverlay" style="font-size:11px">✕ Close</button></div><pre style="flex:1;overflow:auto;font-size:10px;margin:0;white-space:pre-wrap;word-break:break-all;color:var(--vscode-foreground)">' + msg.tail.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>';
    document.getElementById('closeOverlay')?.addEventListener('click', function() { overlay?.remove(); });
  }
});
</script>
</body>
</html>`;
  }
}

function _relativeTime(iso: string): string {
  const sec = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function _escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
