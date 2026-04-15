import * as http from "node:http";
import * as path from "node:path";
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
    requestsPerMinute?: number;
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

export class AnalyticsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "claudeIdeBridge.analyticsView";
  private _refreshTimer?: ReturnType<typeof setInterval>;
  private _lastReport: AnalyticsReport | null = null;
  private _lastPerfReport: PerformanceReport | null = null;
  private _lastProjectContext: Record<string, unknown> | null = null;
  private _lastDiagnostics: unknown | null = null;
  _view?: vscode.WebviewView;

  constructor(
    readonly _extensionUri: vscode.Uri,
    private readonly getReport: () => Promise<AnalyticsReport | null>,
    private readonly _getLockFile: () => Promise<LockFileData | null>,
    private readonly vscodeApi: typeof import("vscode"),
    private readonly _context: import("vscode").ExtensionContext,
  ) {}

  /** Build context-aware presets. */
  private _buildPresets(
    ctx: Record<string, unknown> | null,
    diag: unknown | null,
    report: AnalyticsReport | null,
    perfReport: PerformanceReport | null,
  ): Array<{
    id: string;
    icon: string;
    label: string;
    prompt: string;
    taskId?: string;
  }> {
    const activeFile =
      (ctx?.activeFile as string | undefined) ??
      ((ctx?.brief as Record<string, unknown> | undefined)?.activeFile as
        | string
        | undefined);
    const baseName = activeFile ? path.basename(activeFile) : "";

    // 1. fixErrors
    const diagErrors = Array.isArray(
      (diag as Record<string, unknown> | null)?.errors,
    )
      ? ((diag as Record<string, unknown>).errors as Array<{
          message: string;
          file?: string;
        }>)
      : [];
    const errorCount = diagErrors.length;
    const topErrorFile = diagErrors[0]?.file
      ? path.basename(diagErrors[0].file)
      : "";
    const fixErrors =
      errorCount > 0
        ? {
            id: "fixErrors",
            icon: '<i class="codicon codicon-error"></i>',
            label: `Fix ${errorCount} error${errorCount === 1 ? "" : "s"}${topErrorFile ? ` in ${topErrorFile}` : ""}`,
            prompt: `Call getDiagnostics to get all current errors and warnings${topErrorFile ? ` (start with ${topErrorFile})` : ""}. Fix every error precisely — do not break working code. Run tests after fixing to confirm nothing regressed.`,
          }
        : {
            id: "fixErrors",
            icon: '<i class="codicon codicon-error"></i>',
            label: "Fix all errors",
            prompt:
              "Call getDiagnostics to get all current errors and warnings. Fix every error precisely — do not break working code. Run tests after fixing to confirm nothing regressed.",
          };

    // 2. refactorFile
    const refactorFile = baseName
      ? {
          id: "refactorFile",
          icon: '<i class="codicon codicon-symbol-misc"></i>',
          label: `Refactor ${baseName}`,
          prompt: `Refactor ${activeFile ?? "the active file"} for clarity, readability, and maintainability. Keep all existing behaviour identical. Use getBufferContent to read the current file before making changes.`,
        }
      : {
          id: "refactorFile",
          icon: '<i class="codicon codicon-symbol-misc"></i>',
          label: "Refactor this file",
          prompt:
            "Refactor the active file for clarity, readability, and maintainability. Keep all existing behaviour identical. Use getBufferContent to read the current file before making changes.",
        };

    // 3. addTests — check if recent tasks show a failed test run
    const failedTestTask = report?.recentAutomationTasks.find(
      (t) =>
        t.status === "error" &&
        (t.triggerSource ?? "").toLowerCase().includes("test"),
    );
    const addTests = failedTestTask
      ? {
          id: "addTests",
          icon: '<i class="codicon codicon-beaker"></i>',
          label: "Add tests for failing flow",
          prompt:
            "A recent test run failed. Use getDiagnostics and getBufferContent to identify the failing logic, then write targeted tests that cover the failing flow and edge cases.",
        }
      : {
          id: "addTests",
          icon: '<i class="codicon codicon-beaker"></i>',
          label: `Add tests for ${baseName || "this file"}`,
          prompt:
            "Write comprehensive unit tests for the functions in the active file. Use getBufferContent to read the file. Match the existing test style and patterns in the project. Cover edge cases.",
        };

    // 4. explainCode — if recent commits available
    const recentCommits = (ctx?.recentCommits ??
      (ctx?.brief as Record<string, unknown> | undefined)?.recentCommits) as
      | Array<{ message: string }>
      | undefined;
    const lastCommit = recentCommits?.[0];
    const explainCode = lastCommit
      ? {
          id: "explainCode",
          icon: '<i class="codicon codicon-book"></i>',
          label: "Explain changes from last commit",
          prompt: `Use getGitDiff or getGitLog to get the last commit diff, then explain what changed, why the changes were made, and any non-obvious patterns. Last commit: ${lastCommit.message}`,
        }
      : {
          id: "explainCode",
          icon: '<i class="codicon codicon-book"></i>',
          label: `Explain ${baseName || "this file"}`,
          prompt:
            "Read the active file with getBufferContent and explain what it does: its purpose, key functions, data flow, and any non-obvious patterns. Keep it concise and technical.",
        };

    // 5. optimizePerf — find slowest tool from perTool p99
    let slowestTool: string | null = null;
    if (perfReport?.latency?.perTool) {
      let maxP99 = -1;
      for (const [tool, v] of Object.entries(perfReport.latency.perTool)) {
        if (v.p99 > maxP99) {
          maxP99 = v.p99;
          slowestTool = tool;
        }
      }
    }
    const optimizePerf = slowestTool
      ? {
          id: "optimizePerf",
          icon: '<i class="codicon codicon-dashboard"></i>',
          label: `Optimize slowest fn (${slowestTool})`,
          prompt: `Use getPerformanceReport to find the bottleneck and optimize ${slowestTool}. Identify the root cause of the latency, propose fixes, and apply the most impactful improvements.`,
        }
      : {
          id: "optimizePerf",
          icon: '<i class="codicon codicon-dashboard"></i>',
          label: "Optimize performance",
          prompt:
            "Analyse the active file for performance issues: unnecessary re-renders, expensive loops, blocking I/O, memory leaks. Use getBufferContent to read it, then propose and apply the most impactful fixes.",
        };

    const presets = [
      fixErrors,
      refactorFile,
      addTests,
      explainCode,
      optimizePerf,
    ];

    // 6. resumeLastCancelled — only if cancelled task exists
    const cancelledTask = report?.recentAutomationTasks.find(
      (t) => t.status === "cancelled" || t.status === "interrupted",
    );
    if (cancelledTask) {
      presets.push({
        id: "resumeLastCancelled",
        icon: '<i class="codicon codicon-debug-continue"></i>',
        label: "Resume last cancelled task",
        prompt: "",
        taskId: cancelledTask.id,
      });
    }

    // 7. runTests — always shown
    presets.push({
      id: "runTests",
      icon: '<i class="codicon codicon-play"></i>',
      label: "Run full test suite",
      prompt:
        "Run the full test suite using the appropriate test runner. Report all failures with file and line numbers.",
    });

    return presets;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    const codiconsUri = webviewView.webview.asWebviewUri(
      this.vscodeApi.Uri.joinPath(
        this._extensionUri,
        "out",
        "codicons",
        "codicon.css",
      ),
    );
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.vscodeApi.Uri.joinPath(this._extensionUri, "out"),
      ],
    };

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
                  this._lastPerfReport = perfReport;
                }
              }
            } catch {
              // non-fatal
            }
            // Fetch project context + diagnostics for dynamic presets
            const [ctxResult, diagResult] = await Promise.all([
              this._callBridgeTool(lock, "getProjectContext", {}).catch(
                () => null,
              ),
              this._callBridgeTool(lock, "getDiagnostics", {}).catch(
                () => null,
              ),
            ]);
            this._lastProjectContext = ctxResult as Record<
              string,
              unknown
            > | null;
            this._lastDiagnostics = diagResult;
          }
        } catch {
          // non-fatal
        }
        webviewView.webview.html = this._buildHtml(
          report,
          handoffPreview,
          perfReport,
          codiconsUri,
        );
      } catch {
        webviewView.webview.html = this._buildHtml(null, null);
      }
    };

    void refresh();
    this._refreshTimer = setInterval(() => void refresh(), 15_000);

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
        if (msg.command === "pinNote")
          void this._handlePinNote(webviewView, refresh);
        if (msg.command === "exportNote")
          void this._handleExportNote(webviewView);
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
    // Steps 3+4: tools/call, then always DELETE in finally to prevent slot leak
    let result: unknown = null;
    try {
      result = await new Promise<unknown>((resolve, reject) => {
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
    } finally {
      // Step 4: DELETE session — always runs even if Step 3 threw, preventing slot leak
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
    const presets = this._buildPresets(
      this._lastProjectContext,
      this._lastDiagnostics,
      this._lastReport,
      this._lastPerfReport,
    );
    const preset = presets.find((p) => p.id === key);
    if (!preset) return;
    // resumeLastCancelled uses resume flow
    if (key === "resumeLastCancelled" && preset.taskId) {
      await this._handleResumeTask(view, preset.taskId);
      return;
    }
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
      // If the note is an auto-snapshot (no manual context), start fresh rather
      // than injecting bridge metadata as if it were user intent.
      const isAutoSnap = note.trimStart().startsWith("[auto-snapshot");
      const prompt = isAutoSnap
        ? "Start a new session. Check the current workspace state with getProjectContext, review any open diagnostics, and let me know what you see."
        : `Continue from where we left off.\n\nHandoff note:\n${note}\n\nPick up the next action and proceed.`;
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

  private async _handlePinNote(
    _view: vscode.WebviewView,
    refresh: () => Promise<void>,
  ): Promise<void> {
    try {
      const lock = await this._getLockFile();
      if (!lock) return;
      const noteResult = (await this._callBridgeTool(
        lock,
        "getHandoffNote",
        {},
      )) as {
        content?: Array<{ text?: string }>;
      } | null;
      let noteText: string | null = null;
      if (noteResult?.content?.[0]?.text) {
        try {
          const parsed = JSON.parse(noteResult.content[0].text) as {
            note?: string;
          };
          noteText = parsed.note ?? noteResult.content[0].text;
        } catch {
          noteText = noteResult.content[0].text;
        }
      }
      if (!noteText?.trim()) return;
      // Don't pin auto-snapshots — they're bridge metadata, not user context
      if (noteText.trimStart().startsWith("[auto-snapshot")) {
        view.webview.postMessage({
          command: "showInfo",
          text: "Auto-snapshots can't be pinned. Set a manual handoff note first.",
        });
        return;
      }
      const pins: string[] = this._context.workspaceState.get(
        "pinnedNotes",
        [],
      );
      pins.unshift(noteText);
      const trimmed = pins.slice(0, 5);
      await this._context.workspaceState.update("pinnedNotes", trimmed);
      await refresh();
    } catch {
      // non-fatal
    }
  }

  private async _handleExportNote(view: vscode.WebviewView): Promise<void> {
    try {
      const lock = await this._getLockFile();
      if (!lock) throw new Error("Bridge not running");
      const noteResult = (await this._callBridgeTool(
        lock,
        "getHandoffNote",
        {},
      )) as {
        content?: Array<{ text?: string }>;
      } | null;
      let content: string | null = null;
      if (noteResult?.content?.[0]?.text) {
        try {
          const parsed = JSON.parse(noteResult.content[0].text) as {
            note?: string;
          };
          content = parsed.note ?? noteResult.content[0].text;
        } catch {
          content = noteResult.content[0].text;
        }
      }
      if (!content?.trim()) throw new Error("No handoff note to export");
      // Include HH-MM to avoid same-day overwrites
      const ts = new Date().toISOString().replace(/:/g, "-").slice(0, 16);
      const filename = `session-${ts}.md`;
      const folderUri = this.vscodeApi.workspace.workspaceFolders?.[0]?.uri;
      if (!folderUri) throw new Error("No workspace folder open");
      const fileUri = this.vscodeApi.Uri.joinPath(folderUri, filename);
      await this.vscodeApi.workspace.fs.writeFile(
        fileUri,
        Buffer.from(content),
      );
      void this.vscodeApi.window.showInformationMessage(
        `Handoff note exported to ${filename}`,
      );
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
    codiconsUri?: vscode.Uri,
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
    const isAutoSnapshot =
      handoffPreview?.trimStart().startsWith("[auto-snapshot") ?? false;
    const handoffPreviewHtml = isAutoSnapshot
      ? `<div style="opacity:0.6">Auto-snapshot saved — no manual context yet.</div>`
      : handoffPreview?.trim()
        ? handoffPreview
            .split(/\n+/)
            .slice(0, 2)
            .map((l) => `<div>${_escHtml(l.trim())}</div>`)
            .join("")
        : `<div style="opacity:0.6">No handoff note — start a session to create one.</div>`;
    const hasManualNote = handoffPreview && !isAutoSnapshot;
    const handoffBtnLabel = hasManualNote
      ? "↺ Continue from handoff note"
      : "▶ Start fresh session";
    const handoffDataAttr = hasManualNote ? "" : ' data-fresh="1"';

    // Pinned notes
    const pinnedNotes: string[] = this._context.workspaceState.get(
      "pinnedNotes",
      [],
    );
    const pinnedNotesHtml = pinnedNotes.length
      ? `<details style="margin-bottom:6px;font-size:11px">
  <summary style="cursor:pointer;color:var(--vscode-descriptionForeground);font-size:10px;text-transform:uppercase;letter-spacing:0.06em">Pinned notes (${pinnedNotes.length})</summary>
  ${pinnedNotes
    .map(
      (n) =>
        `<div style="border-left:2px solid var(--vscode-focusBorder,#1f6feb);padding:4px 6px;margin-top:4px;font-size:10px;color:var(--vscode-descriptionForeground)">${_escHtml(n.slice(0, 120))}${n.length > 120 ? "…" : ""}</div>`,
    )
    .join("")}
</details>`
      : "";

    // Dynamic quick task preset buttons
    const presets = this._buildPresets(
      this._lastProjectContext,
      this._lastDiagnostics,
      report,
      perfReport ?? null,
    );
    const presetButtons = presets
      .map(
        (p) =>
          `<button class="preset-btn" data-preset-key="${_escHtml(p.id)}"><span class="preset-icon">${p.icon}</span>${_escHtml(p.label)}</button>`,
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

    // Health badge from performance report — updated thresholds
    const healthScore = perfReport?.health?.score;
    const healthBadgeClass =
      healthScore === undefined
        ? ""
        : healthScore >= 90
          ? "health-green"
          : healthScore >= 70
            ? "health-yellow"
            : "health-red";
    const healthLabel =
      healthScore === undefined
        ? "—"
        : healthScore >= 90
          ? "excellent"
          : healthScore >= 70
            ? "good"
            : "degraded";
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

    const currentP95 = perfReport?.latency?.overallP95Ms ?? null;
    const currentHealthScore = perfReport?.health?.score ?? null;
    const throughputPerMin =
      perfReport?.throughput?.requestsPerMinute ??
      perfReport?.throughput?.callsPerMinute ??
      null;

    return `<!DOCTYPE html>
<html>
<head>
${codiconsUri ? `<link rel="stylesheet" href="${codiconsUri}">` : ""}
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
  .handoff-actions { display: flex; gap: 4px; flex-wrap: wrap; }
  .active-task { display: flex; align-items: center; gap: 6px; background: var(--vscode-terminal-ansiBlue, #1f6feb22); border: 1px solid var(--vscode-focusBorder, #1f6feb55); border-radius: 3px; padding: 4px 6px; margin-bottom: 4px; font-size: 11px; }
  .active-task-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .spinner { animation: spin 1.2s linear infinite; display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .active-task-label { flex: 1; }
  .presets { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin-bottom: 6px; }
  .preset-btn { text-align: left; padding: 5px 6px; font-size: 11px; display: flex; align-items: center; gap: 5px; }
  .preset-icon { font-size: 14px; line-height: 1; display: flex; align-items: center; }
  .preset-icon .codicon { font-size: 14px; }
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
  .panel-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; }
  .panel-title { font-size: 11px; font-weight: 700; letter-spacing: 0.04em; color: var(--vscode-foreground); }
  .hr-divider { border: none; border-top: 1px solid var(--vscode-widget-border, #333); margin: 8px 0; }
</style>
</head>
<body>

<div class="panel-header">
  <span class="panel-title">Claude IDE Bridge</span>
  <button id="refreshBtn" title="Refresh" style="padding:2px 6px;font-size:12px">⟳</button>
</div>

${activeTasksHtml ? `<div style="margin-bottom:8px"><div style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-descriptionForeground);margin-bottom:4px">▸ Active tasks</div>${activeTasksHtml}</div>` : ""}

<hr class="hr-divider">

<h3 onclick="toggleSection('handoff')" title="Click to expand/collapse">Session continuity <span class="toggle" id="handoff-toggle">▾</span></h3>
<div class="collapsible" id="handoff-body" style="max-height:500px;display:block">
  ${pinnedNotesHtml}
  <div class="handoff-box">
    <div class="handoff-preview">${handoffPreviewHtml}</div>
    <div class="handoff-actions">
      <button class="handoff-continue-btn"${handoffDataAttr}>${handoffBtnLabel}</button>
      <button id="pinNoteBtn" title="Pin current note">&#128204;</button>
      <button id="exportNoteBtn" title="Export note to file">&#8595;</button>
    </div>
  </div>
</div>

<hr class="hr-divider">

<h3>Quick tasks</h3>
<div class="presets">${presetButtons}</div>

<hr class="hr-divider">

<h3 onclick="toggleSection('tasks')" title="Click to expand/collapse">Recent tasks <span class="toggle" id="tasks-toggle">▾</span></h3>
<div class="collapsible" id="tasks-body" style="max-height:500px">
  ${recentTasks || "<p style='font-size:11px;color:var(--vscode-descriptionForeground)'>No completed tasks yet.</p>"}
</div>

<hr class="hr-divider">

<h3 onclick="toggleSection('stats')" title="Click to expand/collapse">Stats ${healthBadgeHtml} <span class="toggle" id="stats-toggle">▸</span></h3>
<div class="collapsible collapsed" id="stats-body" style="max-height:500px">
  ${
    healthScore !== undefined
      ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
    <span style="font-size:11px;color:var(--vscode-descriptionForeground)">Health</span>
    <span class="health-badge ${_escHtml(healthBadgeClass)}" style="font-size:15px;font-weight:bold;padding:2px 12px">${healthScore}</span>
    <span style="font-size:10px;color:var(--vscode-descriptionForeground)">${healthLabel}</span>
  </div>`
      : ""
  }
  <div style="font-size:11px;margin-bottom:4px">Hooks fired (${report.windowHours}h): <strong>${report.hooksLast24h}</strong></div>
  <table><tr><th>Tool</th><th>Calls</th><th>Err</th><th>Avg</th></tr>${toolRows || "<tr><td colspan=4>No data yet</td></tr>"}</table>
</div>

${
  latencyRows
    ? `<h3 onclick="toggleSection('latency')" title="Click to expand/collapse">Latency <span class="toggle" id="latency-toggle">▸</span></h3>
<div class="collapsible collapsed" id="latency-body" style="max-height:500px">
  <canvas id="sparklineCanvas" width="200" height="36" style="width:100%;height:36px;display:block;margin-bottom:4px"></canvas>
  <div id="sparkStats" style="font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:6px"></div>
  <table><tr><th>Tool</th><th>Calls</th><th>Err%</th><th>p50</th><th>p95</th></tr>${latencyRows}</table>
</div>`
    : ""
}

<div class="bottom-bar">
  <button class="start-btn" id="startTaskBtn">▶ Start Task</button>
</div>
<div class="last-updated" id="lastUpdated"></div>
<div id="taskStatus"></div>

<script>
const vscodeApi = acquireVsCodeApi();
const generatedAt = new Date(${JSON.stringify(report.generatedAt)});
const currentP95 = ${JSON.stringify(currentP95)};
const currentHealthScore = ${JSON.stringify(currentHealthScore)};
const throughputPerMin = ${JSON.stringify(throughputPerMin)};

function updateAge() {
  var el = document.getElementById('lastUpdated');
  if (!el) return;
  var sec = Math.max(0, Math.round((Date.now() - generatedAt.getTime()) / 1000));
  el.textContent = 'Updated ' + (sec < 60 ? sec + 's' : Math.round(sec / 60) + 'm') + ' ago';
  el.style.color = sec < 30 ? 'var(--vscode-testing-iconPassed,#3fb950)' : 'var(--vscode-descriptionForeground)';
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

// Sparkline
(function() {
  var canvas = document.getElementById('sparklineCanvas');
  if (!canvas || currentP95 === null) return;
  var state = vscodeApi.getState() || {};
  var history = state.p95History || [];
  history.push(currentP95);
  if (history.length > 30) history = history.slice(history.length - 30);
  vscodeApi.setState(Object.assign({}, state, { p95History: history }));
  var statsEl = document.getElementById('sparkStats');
  if (statsEl && currentP95 !== null) {
    statsEl.textContent = 'p95: ' + currentP95 + 'ms' + (throughputPerMin !== null ? ' \u2022 throughput: ' + throughputPerMin + ' req/min' : '');
  }
  var ctx = canvas.getContext('2d');
  if (!ctx || history.length < 2) return;
  var W = canvas.width, H = canvas.height;
  var min = Math.min.apply(null, history), max = Math.max.apply(null, history);
  if (max === min) max = min + 1;
  var score = currentHealthScore;
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = score !== null && score >= 90 ? '#3fb950' : score !== null && score >= 70 ? '#d29922' : '#f85149';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  history.forEach(function(v, i) {
    var x = (i / (history.length - 1)) * W;
    var y = H - ((v - min) / (max - min)) * (H - 4) - 2;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
})();

// Delegated click handler — no inline JS, prevents XSS via task IDs or preset keys
document.addEventListener('click', function(e) {
  var target = e.target && e.target.closest ? e.target.closest('button') : null;
  if (!target) return;
  if (target.id === 'refreshBtn') {
    vscodeApi.postMessage({ command: 'refresh' });
  } else if (target.id === 'startTaskBtn') {
    startTask();
  } else if (target.id === 'pinNoteBtn') {
    vscodeApi.postMessage({ command: 'pinNote' });
  } else if (target.id === 'exportNoteBtn') {
    vscodeApi.postMessage({ command: 'exportNote' });
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
