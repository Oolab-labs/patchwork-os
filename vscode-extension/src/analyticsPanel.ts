import type * as vscode from "vscode";

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
    });
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
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 8px; cursor: pointer; font-size: 11px; margin-top: 8px; }
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
<script>const vscodeApi = acquireVsCodeApi();</script>
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
